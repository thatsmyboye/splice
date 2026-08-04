"""
Splice Analysis Service
=======================
FastAPI microservice for audio analysis.

Given an audio URL (a 30s preview, or a full-length track supplied by the
user), it returns two things:

  1. **Moment embeddings** — a sliding window of 512-dim CLAP vectors, one per
     ~10s of audio. These are what pgvector actually searches, and because each
     row carries its own [start_s, end_s), a match *is* a timestamp. The
     previous design emitted a single 128-dim vector per track, which made
     moment-level matching impossible and forced the API to invent a timestamp
     for every result.

  2. **Display metadata** — key, BPM, time signature, per-section chords, from
     librosa + essentia. This never feeds the search; it's what the result
     cards show.

Deployed on Railway via Docker.
Authentication: X-Service-Secret header (shared secret with web app).
"""

import asyncio
import io
import logging
import os
from contextlib import asynccontextmanager
from typing import Optional

import essentia.standard as ess
import httpx
import librosa
import numpy as np
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import clap_embedder
from clap_embedder import CLAP_SAMPLE_RATE, EMBEDDING_DIM

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

SERVICE_SECRET = os.environ.get("ANALYSIS_SERVICE_SECRET", "")
if not SERVICE_SECRET:
    raise RuntimeError("ANALYSIS_SERVICE_SECRET env var is required")

# Sample rate for the librosa/essentia display-metadata pass. Lower than CLAP's
# 48 kHz because chroma/MFCC/beat tracking gain nothing from the extra
# bandwidth and cost real CPU time at higher rates.
DSP_SAMPLE_RATE = 22050
N_MFCC = 13

# Identifies which embedding space a stored vector belongs to. Bump this
# whenever the checkpoint or window geometry changes — vectors from different
# values are NOT comparable, and silently mixing two spaces is exactly the bug
# that made AcousticBrainz-sourced matches meaningless.
EMBEDDING_MODEL_ID = "clap-music-audioset-v1"

# Analysis is CPU-bound and the service runs a single worker (the CLAP
# checkpoint is ~2 GB resident, so forking workers multiplies that). This
# bounds how many analyses run at once; excess requests queue rather than
# thrashing the box.
ANALYSIS_CONCURRENCY = int(os.environ.get("ANALYSIS_CONCURRENCY", "2"))
_analysis_semaphore: Optional[asyncio.Semaphore] = None

# Full-length uploads are much larger than a 30s preview. Bounded so a single
# request can't exhaust memory.
MAX_AUDIO_BYTES = int(os.environ.get("MAX_AUDIO_BYTES", str(60 * 1024 * 1024)))
AUDIO_FETCH_TIMEOUT_S = float(os.environ.get("AUDIO_FETCH_TIMEOUT_S", "60"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load the checkpoint at startup rather than on first request, so a cold
    # instance fails loudly at boot instead of timing out someone's search.
    global _analysis_semaphore
    _analysis_semaphore = asyncio.Semaphore(ANALYSIS_CONCURRENCY)
    await asyncio.to_thread(clap_embedder.load_model)
    yield


app = FastAPI(title="Splice Analysis Service", version="3.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restricted by service secret, not CORS
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


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


def detect_time_signature(y: np.ndarray, sr: int, tempo: float) -> int:
    """Detect whether the track is in 3/4 or 4/4 time.

    Uses onset-strength autocorrelation: compares energy at 3x vs 4x the
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
    # `preview_url` is the historical name; `audio_url` is the same field for
    # full-length sources. Exactly one must be present.
    preview_url: Optional[str] = None
    audio_url: Optional[str] = None
    spotify_id: str
    mbid: Optional[str] = None

    def resolved_url(self) -> str:
        url = self.audio_url or self.preview_url
        if not url:
            raise HTTPException(status_code=422, detail="preview_url or audio_url is required")
        return url


class SegmentFeatures(BaseModel):
    """Per-section display metadata. Not used for search.

    The chroma/MFCC arrays the previous version stored here existed only so the
    old /embed-window endpoint could reconstruct a query vector from stored
    features. Query vectors now come from the persisted window embeddings
    directly, so those arrays are dropped — they were the bulk of the JSONB
    payload and nothing reads them.
    """
    start_s: float
    duration_s: float
    energy: float             # RMS energy, normalized 0-1
    loudness_db: float        # dB, onset loudness
    spectral_centroid: float  # Hz, normalized 0-1
    chord_label: str          # e.g. 'Am', 'F#', 'N' (no chord / silence)
    chord_confidence: float   # 0.0-1.0, template match score


class MomentWindow(BaseModel):
    """One searchable moment: a time span and its CLAP embedding."""
    start_s: float
    end_s: float
    embedding: list[float]    # 512-dim, L2-normalized


class TrackAnalysis(BaseModel):
    spotify_id: str
    mbid: Optional[str]
    duration_s: float
    bpm: float
    key_name: str             # e.g. 'C', 'F#'
    key_mode: str             # 'major' | 'minor'
    key_confidence: float     # 0.0-1.0, Essentia KeyExtractor strength
    time_signature: int       # 3 or 4
    harmonic_rhythm: float    # chord changes/sec, normalized 0-1
    danceability: float       # 0.0-1.0
    dynamic_complexity: float
    segments: list[SegmentFeatures]
    embedding_model: str      # which space `windows` live in
    embedding_dim: int
    windows: list[MomentWindow]


class EmbedTextRequest(BaseModel):
    """Embed a natural-language moment description into the CLAP space."""
    text: str


class EmbedResponse(BaseModel):
    embedding: list[float]
    embedding_model: str
    embedding_dim: int


# ============================================================
# Audio fetching
# ============================================================

async def fetch_audio_bytes(url: str) -> bytes:
    """Download audio from URL. Raises HTTPException on failure."""
    try:
        async with httpx.AsyncClient(timeout=AUDIO_FETCH_TIMEOUT_S) as client:
            async with client.stream("GET", url, follow_redirects=True) as response:
                response.raise_for_status()

                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > MAX_AUDIO_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail=f"Audio exceeds {MAX_AUDIO_BYTES // (1024 * 1024)}MB limit",
                        )
                    chunks.append(chunk)
                return b"".join(chunks)
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Audio URL fetch timed out")
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Audio URL returned {e.response.status_code}",
        )


# ============================================================
# Feature extraction
# ============================================================

def extract_display_metadata(y_dsp: np.ndarray, sr: int, duration_s: float):
    """librosa + essentia pass: key, BPM, time signature, per-section chords.

    Returns (segments, track_level_dict). Never raises for individual essentia
    algorithms — each degrades to a neutral default so a single failing
    extractor can't sink the whole analysis.
    """
    boundaries = librosa.segment.agglomerative(
        librosa.feature.mfcc(y=y_dsp, sr=sr, n_mfcc=N_MFCC),
        k=min(8, max(2, int(duration_s / 5)))
    )
    boundary_times = librosa.frames_to_time(boundaries, sr=sr)

    section_starts = np.concatenate([[0.0], boundary_times])
    section_ends = np.concatenate([boundary_times, [duration_s]])

    tempo, _ = librosa.beat.beat_track(y=y_dsp, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])

    chroma = librosa.feature.chroma_cqt(y=y_dsp, sr=sr)

    spec_centroid = librosa.feature.spectral_centroid(y=y_dsp, sr=sr)[0]
    spec_centroid_norm = (spec_centroid - spec_centroid.min()) / (
        spec_centroid.max() - spec_centroid.min() + 1e-8
    )

    rms = librosa.feature.rms(y=y_dsp)[0]
    rms_norm = (rms - rms.min()) / (rms.max() - rms.min() + 1e-8)

    segments: list[SegmentFeatures] = []
    for start, end in zip(section_starts, section_ends):
        start_frame = librosa.time_to_frames(start, sr=sr)
        end_frame = min(librosa.time_to_frames(end, sr=sr), chroma.shape[1] - 1)
        if start_frame >= end_frame:
            continue

        seg_chroma_arr = chroma[:, start_frame:end_frame].mean(axis=1)
        seg_y = y_dsp[
            librosa.time_to_samples(start, sr=sr):
            librosa.time_to_samples(end, sr=sr)
        ]
        chord_label, chord_confidence = detect_chord(seg_chroma_arr)

        segments.append(SegmentFeatures(
            start_s=float(start),
            duration_s=float(end - start),
            energy=float(rms_norm[start_frame:end_frame].mean()),
            loudness_db=float(librosa.amplitude_to_db(np.abs(seg_y).mean() + 1e-8)),
            spectral_centroid=float(spec_centroid_norm[start_frame:end_frame].mean()),
            chord_label=chord_label,
            chord_confidence=chord_confidence,
        ))

    y32 = y_dsp.astype(np.float32)

    try:
        key_name, key_mode, strength = ess.KeyExtractor()(y32)
        key_confidence = float(np.clip(strength, 0.0, 1.0))
    except Exception:
        # Zero confidence suppresses any downstream key-based scoring.
        key_name, key_mode, key_confidence = "C", "major", 0.0

    try:
        danceability_val, _ = ess.Danceability(sampleRate=sr)(y32)
        danceability = float(np.clip(danceability_val / 3.0, 0.0, 1.0))
    except Exception:
        danceability = 0.5

    try:
        dynamic_complexity_val, _ = ess.DynamicComplexity(sampleRate=sr)(y32)
        dynamic_complexity = float(dynamic_complexity_val)
    except Exception:
        dynamic_complexity = 0.0

    chord_seq = [s.chord_label for s in segments]
    chord_changes = sum(1 for a, b in zip(chord_seq, chord_seq[1:]) if a != b)
    harmonic_rhythm = float(np.clip(chord_changes / max(duration_s, 1.0) / 2.0, 0.0, 1.0))

    return segments, {
        "bpm": bpm,
        "key_name": key_name,
        "key_mode": key_mode,
        "key_confidence": key_confidence,
        "time_signature": detect_time_signature(y_dsp, sr, bpm),
        "harmonic_rhythm": harmonic_rhythm,
        "danceability": danceability,
        "dynamic_complexity": dynamic_complexity,
    }


def analyze_audio(audio_bytes: bytes, spotify_id: str, mbid: Optional[str]) -> TrackAnalysis:
    """Full pipeline: decode once, embed windows via CLAP, extract display metadata."""
    # Decode at CLAP's rate, then downsample for the DSP pass — decoding twice
    # would double the most expensive part of a full-length track.
    y, _ = librosa.load(io.BytesIO(audio_bytes), sr=CLAP_SAMPLE_RATE, mono=True)
    duration_s = float(librosa.get_duration(y=y, sr=CLAP_SAMPLE_RATE))
    if duration_s <= 0:
        raise HTTPException(status_code=422, detail="Decoded audio is empty")

    windows = clap_embedder.plan_windows(duration_s)
    embeddings = clap_embedder.embed_audio_windows(y, CLAP_SAMPLE_RATE, windows)

    y_dsp = librosa.resample(y, orig_sr=CLAP_SAMPLE_RATE, target_sr=DSP_SAMPLE_RATE)
    segments, track_level = extract_display_metadata(y_dsp, DSP_SAMPLE_RATE, duration_s)

    return TrackAnalysis(
        spotify_id=spotify_id,
        mbid=mbid,
        duration_s=duration_s,
        segments=segments,
        embedding_model=EMBEDDING_MODEL_ID,
        embedding_dim=EMBEDDING_DIM,
        windows=[
            MomentWindow(start_s=start, end_s=end, embedding=vec.tolist())
            for (start, end), vec in zip(windows, embeddings)
        ],
        **track_level,
    )


# ============================================================
# Routes
# ============================================================

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "version": "3.0.0",
        "embedding_model": EMBEDDING_MODEL_ID,
        "embedding_dim": EMBEDDING_DIM,
        "model_loaded": clap_embedder.is_loaded(),
    }


@app.post("/analyze", response_model=TrackAnalysis)
async def analyze(
    request: AnalyzeRequest,
    _: str = Depends(verify_secret),
):
    """Fetch audio, embed its moment windows, and extract display metadata.

    Latency scales with duration: ~5-10s for a 30s preview, proportionally
    longer for a full-length upload.
    """
    url = request.resolved_url()
    logger.info("Analyzing track: %s", request.spotify_id)

    audio_bytes = await fetch_audio_bytes(url)

    assert _analysis_semaphore is not None  # set during lifespan startup
    async with _analysis_semaphore:
        try:
            analysis = await asyncio.to_thread(
                analyze_audio, audio_bytes, request.spotify_id, request.mbid
            )
        except HTTPException:
            raise
        except Exception as e:
            logger.error("Analysis failed for %s: %s", request.spotify_id, e, exc_info=True)
            raise HTTPException(status_code=500, detail=f"Analysis failed: {e}")

    logger.info(
        "Analysis complete for %s: %d windows, %d sections, %.1f BPM, key=%s %s, time_sig=%d/4",
        request.spotify_id, len(analysis.windows), len(analysis.segments),
        analysis.bpm, analysis.key_name, analysis.key_mode, analysis.time_signature,
    )
    return analysis


@app.post("/analyze-upload", response_model=TrackAnalysis)
async def analyze_upload(
    file: UploadFile = File(...),
    spotify_id: str = Form(...),
    mbid: Optional[str] = Form(None),
    _: str = Depends(verify_secret),
):
    """Analyze a user-supplied audio file streamed in as multipart form data.

    This is the full-length path. A 30s preview only ever covers a fraction of
    a track, so a moment the user marked at 3:40 could never be the audio that
    got analyzed — the timestamp they picked and the audio we embedded were
    different things entirely. An uploaded file removes that mismatch.

    The bytes are held in memory for the duration of the request and never
    written to disk or forwarded to storage. Nothing about the audio survives
    the response except the derived embeddings.
    """
    chunks: list[bytes] = []
    total = 0
    while chunk := await file.read(1024 * 1024):
        total += len(chunk)
        if total > MAX_AUDIO_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Audio exceeds {MAX_AUDIO_BYTES // (1024 * 1024)}MB limit",
            )
        chunks.append(chunk)

    if total == 0:
        raise HTTPException(status_code=422, detail="Uploaded file is empty")

    audio_bytes = b"".join(chunks)
    chunks.clear()

    logger.info("Analyzing upload for %s (%.1f MB)", spotify_id, total / (1024 * 1024))

    assert _analysis_semaphore is not None  # set during lifespan startup
    async with _analysis_semaphore:
        try:
            analysis = await asyncio.to_thread(analyze_audio, audio_bytes, spotify_id, mbid)
        except HTTPException:
            raise
        except Exception as e:
            logger.error("Upload analysis failed for %s: %s", spotify_id, e, exc_info=True)
            raise HTTPException(status_code=500, detail=f"Analysis failed: {e}")

    logger.info(
        "Upload analysis complete for %s: %.1fs of audio, %d windows",
        spotify_id, analysis.duration_s, len(analysis.windows),
    )
    return analysis


@app.post("/embed-text", response_model=EmbedResponse)
async def embed_text(
    request: EmbedTextRequest,
    _: str = Depends(verify_secret),
):
    """Embed a moment description into the same space as the audio windows.

    This is what lets a typed description ("the bit where everything drops out")
    query the catalog directly, with no LLM in the retrieval path.
    """
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="text must not be empty")

    try:
        embedding = await asyncio.to_thread(clap_embedder.embed_text, [text])
    except Exception as e:
        logger.error("Text embedding failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Text embedding failed: {e}")

    return EmbedResponse(
        embedding=embedding[0].tolist(),
        embedding_model=EMBEDDING_MODEL_ID,
        embedding_dim=EMBEDDING_DIM,
    )
