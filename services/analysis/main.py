"""
Splice Analysis Service
=======================
FastAPI microservice for audio analysis.
Accepts a 30-second audio URL (Spotify preview), runs librosa + essentia,
returns segment-level features and a 128-dim normalized embedding vector.

Deployed on Railway via Docker.
Authentication: X-Service-Secret header (shared secret with web app).
"""

import os
import io
import json
import logging
import hashlib
from typing import Optional

import httpx
import numpy as np
import librosa
import essentia.standard as ess
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, HttpUrl

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Splice Analysis Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restricted by service secret, not CORS
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

SERVICE_SECRET = os.environ.get("ANALYSIS_SERVICE_SECRET", "")
if not SERVICE_SECRET:
    raise RuntimeError("ANALYSIS_SERVICE_SECRET env var is required")

EMBEDDING_DIM = 128
SAMPLE_RATE = 22050
N_MFCC = 13
N_CHROMA = 12


# ============================================================
# Auth dependency
# ============================================================

def verify_secret(x_service_secret: str = Header(...)):
    if x_service_secret != SERVICE_SECRET:
        raise HTTPException(status_code=401, detail="Invalid service secret")


# ============================================================
# Pydantic models
# ============================================================

class AnalyzeRequest(BaseModel):
    preview_url: str          # Spotify 30s preview MP3 URL
    spotify_id: str           # for logging/caching reference
    mbid: Optional[str] = None


class SegmentFeatures(BaseModel):
    start_s: float
    duration_s: float
    energy: float             # RMS energy, normalized 0–1
    loudness_db: float        # dB, onset loudness
    spectral_centroid: float  # Hz, normalized 0–1
    chroma_vector: list[float]  # 12-dim chroma (pitch class profile)
    mfcc_means: list[float]   # 13-dim MFCC means


class TrackAnalysis(BaseModel):
    spotify_id: str
    mbid: Optional[str]
    duration_s: float
    bpm: float
    key_name: str             # e.g. 'C', 'F#'
    key_mode: str             # 'major' | 'minor'
    danceability: float       # 0.0–1.0
    dynamic_complexity: float
    segments: list[SegmentFeatures]
    embedding: list[float]    # 128-dim normalized vector


class EmbedRequest(BaseModel):
    """
    Convert a pre-existing feature dict to an embedding vector.
    Used for moment descriptor → vector conversion on the web side.
    """
    features: dict


class EmbedResponse(BaseModel):
    embedding: list[float]


# ============================================================
# Audio fetching
# ============================================================

async def fetch_audio_bytes(url: str) -> bytes:
    """Download audio from URL. Raises HTTPException on failure."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(url, follow_redirects=True)
            response.raise_for_status()
            return response.content
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Audio URL fetch timed out")
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Audio URL returned {e.response.status_code}"
        )


# ============================================================
# Feature extraction
# ============================================================

def extract_features(audio_bytes: bytes, spotify_id: str) -> TrackAnalysis:
    """
    Core analysis pipeline.
    1. Load audio via librosa (resampled to 22050 Hz mono)
    2. Detect sections (structural segmentation)
    3. Extract per-segment features
    4. Run essentia for tonal/rhythm analysis
    5. Build 128-dim embedding
    """

    # --- Load audio ---
    y, sr = librosa.load(io.BytesIO(audio_bytes), sr=SAMPLE_RATE, mono=True)
    duration_s = librosa.get_duration(y=y, sr=sr)

    # --- Structural segmentation ---
    # librosa's recurrence matrix-based segmentation
    # Returns boundary frame indices
    boundaries = librosa.segment.agglomerative(
        librosa.feature.mfcc(y=y, sr=sr, n_mfcc=N_MFCC),
        k=min(8, max(2, int(duration_s / 5)))  # ~1 segment per 5 seconds, max 8
    )
    boundary_times = librosa.frames_to_time(boundaries, sr=sr)

    # Ensure we have start=0 and end=duration
    section_starts = np.concatenate([[0.0], boundary_times])
    section_ends = np.concatenate([boundary_times, [duration_s]])

    # --- Track-level features via librosa ---
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(tempo)

    # Chroma (12-dim pitch class profile)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)

    # MFCCs (13 coefficients)
    mfccs = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=N_MFCC)

    # Spectral centroid
    spec_centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    spec_centroid_norm = (spec_centroid - spec_centroid.min()) / (
        spec_centroid.max() - spec_centroid.min() + 1e-8
    )

    # RMS energy
    rms = librosa.feature.rms(y=y)[0]
    rms_norm = (rms - rms.min()) / (rms.max() - rms.min() + 1e-8)

    # --- Per-segment feature extraction ---
    segments = []
    all_segment_vectors = []

    for start, end in zip(section_starts, section_ends):
        start_frame = librosa.time_to_frames(start, sr=sr)
        end_frame = librosa.time_to_frames(end, sr=sr)

        # Clamp to array bounds
        end_frame = min(end_frame, chroma.shape[1] - 1)
        if start_frame >= end_frame:
            continue

        seg_chroma = chroma[:, start_frame:end_frame].mean(axis=1).tolist()
        seg_mfcc = mfccs[:, start_frame:end_frame].mean(axis=1).tolist()
        seg_energy = float(rms_norm[start_frame:end_frame].mean())
        seg_centroid = float(spec_centroid_norm[start_frame:end_frame].mean())

        # Onset loudness (dBFS approximation)
        seg_y = y[
            librosa.time_to_samples(start, sr=sr):
            librosa.time_to_samples(end, sr=sr)
        ]
        loudness_db = float(librosa.amplitude_to_db(
            np.abs(seg_y).mean() + 1e-8
        ))

        seg_features = SegmentFeatures(
            start_s=float(start),
            duration_s=float(end - start),
            energy=seg_energy,
            loudness_db=loudness_db,
            spectral_centroid=seg_centroid,
            chroma_vector=seg_chroma,
            mfcc_means=seg_mfcc,
        )
        segments.append(seg_features)

        # Flatten for embedding
        seg_vector = np.array(
            [seg_energy, seg_centroid, loudness_db] + seg_chroma + seg_mfcc
        )
        all_segment_vectors.append(seg_vector)

    # --- Essentia tonal + rhythm analysis ---
    # Essentia expects float32 numpy array
    audio_essentia = ess.MonoLoader(
        filename="",  # will use buffer below
        sampleRate=SAMPLE_RATE
    )

    # Use essentia's streaming extractor via array input
    key_extractor = ess.KeyExtractor()
    try:
        key, scale, strength = key_extractor(y.astype(np.float32))
        key_name = key
        key_mode = scale  # 'major' or 'minor'
    except Exception:
        key_name = "C"
        key_mode = "major"

    try:
        danceability_algo = ess.Danceability(sampleRate=SAMPLE_RATE)
        danceability_val, _ = danceability_algo(y.astype(np.float32))
        danceability = float(np.clip(danceability_val / 3.0, 0.0, 1.0))  # normalize ~0–3 range
    except Exception:
        danceability = 0.5

    try:
        dynamic_complexity_algo = ess.DynamicComplexity(sampleRate=SAMPLE_RATE)
        dynamic_complexity_val, _ = dynamic_complexity_algo(y.astype(np.float32))
        dynamic_complexity = float(dynamic_complexity_val)
    except Exception:
        dynamic_complexity = 0.0

    # --- Build 128-dim embedding ---
    embedding = build_embedding(
        segment_vectors=all_segment_vectors,
        bpm=bpm,
        danceability=danceability,
        dynamic_complexity=dynamic_complexity,
        global_chroma=chroma.mean(axis=1),
        global_mfcc=mfccs.mean(axis=1),
    )

    return TrackAnalysis(
        spotify_id=spotify_id,
        mbid=None,
        duration_s=duration_s,
        bpm=bpm,
        key_name=key_name,
        key_mode=key_mode,
        danceability=danceability,
        dynamic_complexity=dynamic_complexity,
        segments=segments,
        embedding=embedding.tolist(),
    )


def build_embedding(
    segment_vectors: list[np.ndarray],
    bpm: float,
    danceability: float,
    dynamic_complexity: float,
    global_chroma: np.ndarray,
    global_mfcc: np.ndarray,
) -> np.ndarray:
    """
    Construct the 128-dim track embedding.

    Composition:
      - 12  dims: global chroma (pitch class profile)
      - 13  dims: global MFCC means
      - 12  dims: chroma variance across segments (tonal variety)
      - 13  dims: MFCC variance across segments (timbral variety)
      - 64  dims: PCA-reduced segment matrix (top 64 principal components)
      -  2  dims: [normalized BPM, danceability]
      - 12  dims: dynamic complexity + segment energy profile (mean + std per segment)
      -------
        128 total
    """
    parts = []

    # Global chroma (12) + MFCC (13) = 25 dims
    parts.append(_normalize(global_chroma))          # 12
    parts.append(_normalize(global_mfcc))            # 13

    if len(segment_vectors) >= 2:
        seg_matrix = np.vstack(segment_vectors)       # shape: (n_segments, n_features)

        # Variance across segments = 12 chroma + 13 mfcc = 25 dims
        # (features at indices 3:15 are chroma, 15:28 are mfcc in our seg vector)
        chroma_cols = seg_matrix[:, 3:15]
        mfcc_cols   = seg_matrix[:, 15:28]
        parts.append(_normalize(chroma_cols.std(axis=0)))   # 12
        parts.append(_normalize(mfcc_cols.std(axis=0)))     # 13

        # PCA reduction to 64 dims
        n_components = min(64, seg_matrix.shape[0], seg_matrix.shape[1])
        if n_components < 64:
            # Pad with zeros if not enough components
            pca_reduced = np.zeros(64)
            pca_reduced[:n_components] = _pca_reduce(seg_matrix, n_components)
        else:
            pca_reduced = _pca_reduce(seg_matrix, 64)
        parts.append(_normalize(pca_reduced))               # 64
    else:
        # Fallback: pad with zeros
        parts.append(np.zeros(12))   # chroma variance
        parts.append(np.zeros(13))   # mfcc variance
        parts.append(np.zeros(64))   # pca

    # BPM normalized (typical range 60–200 BPM → 0–1)
    bpm_norm = float(np.clip((bpm - 60) / 140, 0.0, 1.0))
    parts.append(np.array([bpm_norm, float(danceability)]))  # 2

    # Dynamic complexity + padding to reach 12 dims
    complexity_features = np.zeros(12)
    complexity_features[0] = float(np.clip(dynamic_complexity / 10.0, 0.0, 1.0))
    if len(segment_vectors) > 0:
        energies = np.array([v[0] for v in segment_vectors])
        complexity_features[1] = float(energies.mean())
        complexity_features[2] = float(energies.std())
    parts.append(complexity_features)  # 12

    embedding = np.concatenate(parts)

    # Ensure exactly 128 dims (truncate or pad)
    if len(embedding) > EMBEDDING_DIM:
        embedding = embedding[:EMBEDDING_DIM]
    elif len(embedding) < EMBEDDING_DIM:
        embedding = np.pad(embedding, (0, EMBEDDING_DIM - len(embedding)))

    # L2 normalize for cosine similarity
    norm = np.linalg.norm(embedding)
    if norm > 1e-8:
        embedding = embedding / norm

    return embedding


def _normalize(arr: np.ndarray) -> np.ndarray:
    """Min-max normalize to [0, 1]."""
    mn, mx = arr.min(), arr.max()
    if mx - mn < 1e-8:
        return np.zeros_like(arr)
    return (arr - mn) / (mx - mn)


def _pca_reduce(matrix: np.ndarray, n_components: int) -> np.ndarray:
    """Simple PCA via SVD. Returns first n_components principal components."""
    centered = matrix - matrix.mean(axis=0)
    _, _, Vt = np.linalg.svd(centered, full_matrices=False)
    projected = centered @ Vt[:n_components].T
    return projected.mean(axis=0)  # average across segments → 1D vector


def moment_descriptor_to_embedding(descriptor: dict) -> np.ndarray:
    """
    Convert a Claude MomentDescriptor (from /api/interpret) into a 64-dim vector
    for moment-to-moment matching in Phase 2.

    MomentDescriptor fields (all 0–1 floats):
      energy_profile, timbral_character, harmonic_tension,
      structural_position, textural_density, emotional_arc
    """
    keys = [
        "energy_profile", "timbral_character", "harmonic_tension",
        "structural_position", "textural_density", "emotional_arc"
    ]
    base = np.array([float(descriptor.get(k, 0.5)) for k in keys])

    # Expand to 64 dims via simple Fourier-like basis
    expanded = np.zeros(64)
    for i, val in enumerate(base):
        for j in range(10):
            idx = i * 10 + j
            if idx < 64:
                expanded[idx] = val * np.cos(j * np.pi * val)

    norm = np.linalg.norm(expanded)
    if norm > 1e-8:
        expanded = expanded / norm

    return expanded


# ============================================================
# Routes
# ============================================================

@app.get("/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}


@app.post("/analyze", response_model=TrackAnalysis)
async def analyze(
    request: AnalyzeRequest,
    _: str = Depends(verify_secret),
):
    """
    Main analysis endpoint.
    Fetches audio from preview_url, runs librosa + essentia, returns features.
    Typical latency: 3–8 seconds for a 30s preview.
    """
    logger.info(f"Analyzing track: {request.spotify_id}")

    audio_bytes = await fetch_audio_bytes(request.preview_url)

    try:
        analysis = extract_features(audio_bytes, request.spotify_id)
    except Exception as e:
        logger.error(f"Analysis failed for {request.spotify_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Analysis failed: {str(e)}")

    logger.info(
        f"Analysis complete for {request.spotify_id}: "
        f"{len(analysis.segments)} segments, {analysis.bpm:.1f} BPM"
    )
    return analysis


@app.post("/embed", response_model=EmbedResponse)
async def embed(
    request: EmbedRequest,
    _: str = Depends(verify_secret),
):
    """
    Convert a MomentDescriptor dict to a 64-dim embedding vector.
    Used by the web app when constructing moment-to-moment queries.
    """
    try:
        embedding = moment_descriptor_to_embedding(request.features)
        return EmbedResponse(embedding=embedding.tolist())
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Embedding failed: {str(e)}")
