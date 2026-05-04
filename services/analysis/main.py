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
import logging
from typing import Optional

import httpx
import numpy as np
import librosa
import essentia.standard as ess
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Splice Analysis Service", version="2.0.0")

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

# Circle-of-fifths position map (enharmonic equivalents share a slot)
_COF: dict[str, int] = {
    "C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5,
    "F#": 6, "Gb": 6, "C#": 7, "Db": 7, "Ab": 8,
    "Eb": 9, "Bb": 10, "F": 11,
}

# ============================================================
# Chord template library (built once at module load)
# ============================================================

_CHORD_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _build_chord_templates() -> dict[str, np.ndarray]:
    templates: dict[str, np.ndarray] = {}
    for i, name in enumerate(_CHORD_NAMES):
        major = np.zeros(12)
        major[i % 12] = 1.0
        major[(i + 4) % 12] = 0.5   # major third
        major[(i + 7) % 12] = 0.5   # perfect fifth

        minor = np.zeros(12)
        minor[i % 12] = 1.0
        minor[(i + 3) % 12] = 0.5   # minor third
        minor[(i + 7) % 12] = 0.5   # perfect fifth

        templates[name] = major / np.linalg.norm(major)
        templates[f"{name}m"] = minor / np.linalg.norm(minor)
    return templates


_CHORD_TEMPLATES = _build_chord_templates()


def detect_chord(chroma_vector: np.ndarray) -> tuple[str, float]:
    """Template-match a 12-dim chroma vector against 24 major/minor chord templates.

    Returns (chord_label, confidence) where confidence is the cosine similarity
    score of the best match. Returns ('N', 0.0) for silent/empty segments.
    """
    norm = float(np.linalg.norm(chroma_vector))
    if norm < 1e-8:
        return "N", 0.0
    chroma_norm = chroma_vector / norm
    best_label, best_score = "N", 0.0
    for label, template in _CHORD_TEMPLATES.items():
        score = float(np.dot(chroma_norm, template))
        if score > best_score:
            best_score = score
            best_label = label
    return best_label, round(best_score, 4)


# ============================================================
# Time signature detection
# ============================================================

def detect_time_signature(y: np.ndarray, sr: int, tempo: float) -> int:
    """Detect whether the track is in 3/4 or 4/4 time.

    Uses onset-strength autocorrelation: compares energy at 3× vs 4× the
    beat period. A 5% bias toward 4/4 encodes the prior that most music is
    in duple meter.

    Returns 3 or 4.
    """
    try:
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        ac = librosa.autocorrelate(onset_env, max_size=sr // 2)
        beat_period_frames = int(librosa.time_to_frames(60.0 / max(tempo, 1.0), sr=sr))
        if beat_period_frames < 1:
            return 4
        three_idx = min(3 * beat_period_frames, len(ac) - 1)
        four_idx = min(4 * beat_period_frames, len(ac) - 1)
        score_3 = float(ac[three_idx])
        score_4 = float(ac[four_idx])
        return 3 if score_3 > score_4 * 1.05 else 4
    except Exception:
        return 4


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
    chroma_vector: list[float]   # 12-dim chroma (pitch class profile)
    mfcc_means: list[float]      # 13-dim MFCC means
    chord_label: str             # e.g. 'Am', 'F#', 'N' (no chord / silence)
    chord_confidence: float      # 0.0–1.0, template match score


class TrackAnalysis(BaseModel):
    spotify_id: str
    mbid: Optional[str]
    duration_s: float
    bpm: float
    key_name: str             # e.g. 'C', 'F#'
    key_mode: str             # 'major' | 'minor'
    key_confidence: float     # 0.0–1.0, Essentia KeyExtractor strength
    time_signature: int       # 3 or 4
    harmonic_rhythm: float    # chord changes/sec, normalized 0–1
    danceability: float       # 0.0–1.0
    dynamic_complexity: float
    segments: list[SegmentFeatures]
    embedding: list[float]    # 128-dim normalized vector (v2 layout)


class EmbedRequest(BaseModel):
    """Convert a pre-existing feature dict to an embedding vector."""
    features: dict


class EmbedWindowRequest(BaseModel):
    """Compute a 128-dim query embedding for a selected time window within a track."""
    segments: list[dict]           # Full segments array from track_features (v2.0)
    timestamp_s: float             # Start of selected window / single-mark timestamp
    timestamp_end_s: Optional[float] = None  # End of window; None = single-mark
    bpm: float = 120.0
    key_name: str = "C"
    key_mode: str = "major"
    time_signature: int = 4
    harmonic_rhythm: float = 0.0
    danceability: float = 0.5
    dynamic_complexity: float = 0.0


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
    3. Extract per-segment features including chord detection
    4. Run essentia for tonal/rhythm analysis
    5. Detect time signature via onset autocorrelation
    6. Build 128-dim v2 embedding
    """

    # --- Load audio ---
    y, sr = librosa.load(io.BytesIO(audio_bytes), sr=SAMPLE_RATE, mono=True)
    duration_s = librosa.get_duration(y=y, sr=sr)

    # --- Structural segmentation ---
    boundaries = librosa.segment.agglomerative(
        librosa.feature.mfcc(y=y, sr=sr, n_mfcc=N_MFCC),
        k=min(8, max(2, int(duration_s / 5)))
    )
    boundary_times = librosa.frames_to_time(boundaries, sr=sr)

    section_starts = np.concatenate([[0.0], boundary_times])
    section_ends = np.concatenate([boundary_times, [duration_s]])

    # --- Track-level features via librosa ---
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    mfccs = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=N_MFCC)

    spec_centroid = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
    spec_centroid_norm = (spec_centroid - spec_centroid.min()) / (
        spec_centroid.max() - spec_centroid.min() + 1e-8
    )

    rms = librosa.feature.rms(y=y)[0]
    rms_norm = (rms - rms.min()) / (rms.max() - rms.min() + 1e-8)

    # --- Per-segment feature extraction ---
    segments: list[SegmentFeatures] = []
    all_segment_vectors: list[np.ndarray] = []

    for start, end in zip(section_starts, section_ends):
        start_frame = librosa.time_to_frames(start, sr=sr)
        end_frame = librosa.time_to_frames(end, sr=sr)

        end_frame = min(end_frame, chroma.shape[1] - 1)
        if start_frame >= end_frame:
            continue

        seg_chroma_arr = chroma[:, start_frame:end_frame].mean(axis=1)
        seg_chroma = seg_chroma_arr.tolist()
        seg_mfcc = mfccs[:, start_frame:end_frame].mean(axis=1).tolist()
        seg_energy = float(rms_norm[start_frame:end_frame].mean())
        seg_centroid = float(spec_centroid_norm[start_frame:end_frame].mean())

        seg_y = y[
            librosa.time_to_samples(start, sr=sr):
            librosa.time_to_samples(end, sr=sr)
        ]
        loudness_db = float(librosa.amplitude_to_db(
            np.abs(seg_y).mean() + 1e-8
        ))

        chord_label, chord_confidence = detect_chord(seg_chroma_arr)

        seg_features = SegmentFeatures(
            start_s=float(start),
            duration_s=float(end - start),
            energy=seg_energy,
            loudness_db=loudness_db,
            spectral_centroid=seg_centroid,
            chroma_vector=seg_chroma,
            mfcc_means=seg_mfcc,
            chord_label=chord_label,
            chord_confidence=chord_confidence,
        )
        segments.append(seg_features)

        seg_vector = np.array(
            [seg_energy, seg_centroid, loudness_db] + seg_chroma + seg_mfcc
        )
        all_segment_vectors.append(seg_vector)

    # --- Essentia tonal + rhythm analysis ---
    key_extractor = ess.KeyExtractor()
    try:
        key, scale, strength = key_extractor(y.astype(np.float32))
        key_name = key
        key_mode = scale  # 'major' or 'minor'
        key_confidence = float(np.clip(strength, 0.0, 1.0))
    except Exception:
        key_name = "C"
        key_mode = "major"
        key_confidence = 0.0  # unknown — zero confidence suppresses key-boost scoring

    try:
        danceability_algo = ess.Danceability(sampleRate=SAMPLE_RATE)
        danceability_val, _ = danceability_algo(y.astype(np.float32))
        danceability = float(np.clip(danceability_val / 3.0, 0.0, 1.0))
    except Exception:
        danceability = 0.5

    try:
        dynamic_complexity_algo = ess.DynamicComplexity(sampleRate=SAMPLE_RATE)
        dynamic_complexity_val, _ = dynamic_complexity_algo(y.astype(np.float32))
        dynamic_complexity = float(dynamic_complexity_val)
    except Exception:
        dynamic_complexity = 0.0

    # --- Time signature detection ---
    time_signature = detect_time_signature(y, sr, bpm)

    # --- Harmonic rhythm: chord changes per second, normalized to 0–1 ---
    chord_labels_seq = [s.chord_label for s in segments]
    chord_changes = sum(
        1 for a, b in zip(chord_labels_seq, chord_labels_seq[1:]) if a != b
    )
    harmonic_rhythm = float(np.clip(
        chord_changes / max(duration_s, 1.0) / 2.0,
        0.0, 1.0
    ))

    # --- Build 128-dim v2 embedding ---
    embedding = build_embedding(
        segment_vectors=all_segment_vectors,
        bpm=bpm,
        danceability=danceability,
        dynamic_complexity=dynamic_complexity,
        global_chroma=chroma.mean(axis=1),
        global_mfcc=mfccs.mean(axis=1),
        key_name=key_name,
        key_mode=key_mode,
        time_signature=time_signature,
        harmonic_rhythm=harmonic_rhythm,
    )

    return TrackAnalysis(
        spotify_id=spotify_id,
        mbid=None,
        duration_s=duration_s,
        bpm=bpm,
        key_name=key_name,
        key_mode=key_mode,
        key_confidence=key_confidence,
        time_signature=time_signature,
        harmonic_rhythm=harmonic_rhythm,
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
    key_name: str = "C",
    key_mode: str = "major",
    time_signature: int = 4,
    harmonic_rhythm: float = 0.0,
) -> np.ndarray:
    """
    Construct the 128-dim track embedding (v2 layout).

      Dims   Count  Content
      -----  -----  -------
      0–11    12    Global chroma mean (pitch class profile)
      12–24   13    Global MFCC means
      25–36   12    Chroma variance across segments
      37–49   13    MFCC variance across segments
      50–111  62    SVD-PCA reduced segment matrix
      112–113  2    Key encoding: COF position + mode
      114–115  2    BPM (normalized) + danceability
      116–117  2    Time signature (norm) + harmonic rhythm
      118–127 10    Dynamic complexity + segment energy profile
      ------  ---
              128   total
    """
    parts = []

    # Global chroma (12) + MFCC (13) = 25 dims
    parts.append(_normalize(global_chroma))    # 12
    parts.append(_normalize(global_mfcc))      # 13

    if len(segment_vectors) >= 2:
        seg_matrix = np.vstack(segment_vectors)

        chroma_cols = seg_matrix[:, 3:15]
        mfcc_cols   = seg_matrix[:, 15:28]
        parts.append(_normalize(chroma_cols.std(axis=0)))   # 12
        parts.append(_normalize(mfcc_cols.std(axis=0)))     # 13

        # PCA reduction to 62 dims (reduced from 64 to free room for harmonic dims)
        n_components = min(62, seg_matrix.shape[0], seg_matrix.shape[1])
        pca_reduced = np.zeros(62)
        pca_reduced[:n_components] = _pca_reduce(seg_matrix, n_components)
        parts.append(_normalize(pca_reduced))               # 62
    else:
        parts.append(np.zeros(12))   # chroma variance
        parts.append(np.zeros(13))   # mfcc variance
        parts.append(np.zeros(62))   # pca

    # Key encoding: circle-of-fifths position (0–1) + mode (major=1.0, minor=0.0)
    cof_pos = _COF.get(key_name, 0) / 11.0
    mode_float = 1.0 if key_mode == "major" else 0.0
    parts.append(np.array([cof_pos, mode_float]))           # 2

    # BPM normalized (60–200 BPM → 0–1) + danceability
    bpm_norm = float(np.clip((bpm - 60) / 140, 0.0, 1.0))
    parts.append(np.array([bpm_norm, float(danceability)])) # 2

    # Time signature (4/4=1.0, 3/4=0.0) + harmonic rhythm
    ts_norm = 1.0 if time_signature == 4 else 0.0
    parts.append(np.array([ts_norm, float(harmonic_rhythm)])) # 2

    # Dynamic complexity + segment energy profile (10 dims)
    energy_features = np.zeros(10)
    energy_features[0] = float(np.clip(dynamic_complexity / 10.0, 0.0, 1.0))
    if len(segment_vectors) > 0:
        energies = np.array([v[0] for v in segment_vectors])
        energy_features[1] = float(energies.mean())
        energy_features[2] = float(energies.std())
    parts.append(energy_features)                           # 10

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
    return projected.mean(axis=0)


def moment_descriptor_to_embedding(descriptor: dict) -> np.ndarray:
    """
    Convert a Claude MomentDescriptor (from /api/interpret) into a 64-dim vector
    for moment-to-moment matching in Phase 2.
    """
    keys = [
        "energy_profile", "timbral_character", "harmonic_tension",
        "structural_position", "textural_density", "emotional_arc"
    ]
    base = np.array([float(descriptor.get(k, 0.5)) for k in keys])

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
    return {"status": "ok", "version": "2.0.0"}


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
        f"{len(analysis.segments)} segments, {analysis.bpm:.1f} BPM, "
        f"key={analysis.key_name} {analysis.key_mode}, "
        f"time_sig={analysis.time_signature}/4"
    )
    return analysis


@app.post("/embed", response_model=EmbedResponse)
async def embed(
    request: EmbedRequest,
    _: str = Depends(verify_secret),
):
    """Convert a MomentDescriptor dict to a 64-dim embedding vector."""
    try:
        embedding = moment_descriptor_to_embedding(request.features)
        return EmbedResponse(embedding=embedding.tolist())
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Embedding failed: {str(e)}")


@app.post("/embed-window", response_model=EmbedResponse)
async def embed_window(
    request: EmbedWindowRequest,
    _: str = Depends(verify_secret),
):
    """
    Compute a 128-dim query embedding for a selected time window.

    Filters the stored segment array to segments overlapping the requested
    window, then runs the same build_embedding() pipeline used during full
    track analysis. This produces a query vector in the same space as the
    catalog, making the pgvector search moment-aware rather than track-level.

    For a single-mark timestamp, the containing segment (or nearest segment)
    is used. Falls back to all segments if no window segments are found.
    """
    all_segs = request.segments
    if not all_segs:
        raise HTTPException(status_code=400, detail="No segments provided")

    ts = request.timestamp_s
    te = request.timestamp_end_s

    if te is not None and te > ts:
        # Window: all segments that overlap [ts, te)
        window_segs = [
            s for s in all_segs
            if s["start_s"] < te and (s["start_s"] + s.get("duration_s", 0.0)) > ts
        ]
    else:
        # Single mark: segment containing ts, or nearest segment
        containing = [
            s for s in all_segs
            if s["start_s"] <= ts < (s["start_s"] + s.get("duration_s", 0.0))
        ]
        window_segs = containing if containing else [
            min(all_segs, key=lambda s: abs(s["start_s"] - ts))
        ]

    if not window_segs:
        window_segs = all_segs

    seg_vectors: list[np.ndarray] = []
    chroma_arrays: list[np.ndarray] = []
    mfcc_arrays: list[np.ndarray] = []

    for s in window_segs:
        chroma = np.array(s.get("chroma_vector", [0.0] * N_CHROMA), dtype=float)
        mfcc = np.array(s.get("mfcc_means", [0.0] * N_MFCC), dtype=float)
        energy = float(s.get("energy", 0.0))
        centroid = float(s.get("spectral_centroid", 0.0))
        loudness = float(s.get("loudness_db", -60.0))
        # Segment vector layout matches build_embedding() expectation:
        # index 0=energy, 1=centroid, 2=loudness, 3:15=chroma, 15:28=mfcc
        seg_vectors.append(np.concatenate([[energy, centroid, loudness], chroma, mfcc]))
        chroma_arrays.append(chroma)
        mfcc_arrays.append(mfcc)

    global_chroma = np.mean(chroma_arrays, axis=0)
    global_mfcc = np.mean(mfcc_arrays, axis=0)

    embedding = build_embedding(
        segment_vectors=seg_vectors,
        bpm=request.bpm,
        danceability=request.danceability,
        dynamic_complexity=request.dynamic_complexity,
        global_chroma=global_chroma,
        global_mfcc=global_mfcc,
        key_name=request.key_name,
        key_mode=request.key_mode,
        time_signature=request.time_signature,
        harmonic_rhythm=request.harmonic_rhythm,
    )
    return EmbedResponse(embedding=embedding.tolist())
