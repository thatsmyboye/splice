"""
CLAP embedding backend
======================
Wraps LAION-CLAP (music checkpoint) to produce 512-dim embeddings for audio
windows *and* for natural-language text, in a single shared space.

Why CLAP rather than the previous hand-built 128-dim vector:

  1. The old embedding was a hand-designed concatenation (chroma means, MFCC
     variances, an SVD projection, some scalars) min-max normalized into
     [0, 1]. All-non-negative unit vectors are high-cosine by construction, so
     real similarity spanned a ~0.27-wide band and ranking was close to
     arbitrary.

  2. CLAP has a text tower. The user's description of a moment ("when the bass
     drops and everything goes quiet") embeds into the *same* space as audio,
     so it can query the catalog directly instead of being routed through an
     LLM into six floats. That removes the weakest link in the search loop.

Model loading is process-global and happens once at startup — the checkpoint is
~2 GB resident, which is why the service runs a single uvicorn worker and fans
out CPU-bound work to a threadpool instead of forking workers.
"""

import logging
import os
import threading
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# CLAP's audio frontend is trained at 48 kHz. Audio must be resampled to this
# before embedding, independent of the rate used for librosa DSP.
CLAP_SAMPLE_RATE = 48_000

# Joint audio/text embedding dimensionality for the LAION-CLAP checkpoints.
EMBEDDING_DIM = 512

# CLAP's audio encoder natively consumes ~10s chunks, so a 10s window is the
# natural analysis unit. A 5s hop gives 50% overlap, so a moment that straddles
# a window boundary still lands near the centre of some window.
DEFAULT_WINDOW_S = 10.0
DEFAULT_HOP_S = 5.0

# Number of windows embedded per forward pass. Bounded to keep peak memory
# predictable on a small Railway instance when a full-length upload produces
# 100+ windows.
BATCH_SIZE = 16

_CHECKPOINT_PATH = os.environ.get("CLAP_CHECKPOINT_PATH", "/models/music_audioset_epoch_15_esc_90.14.pt")
_AUDIO_MODEL = os.environ.get("CLAP_AUDIO_MODEL", "HTSAT-base")

_model = None
_model_lock = threading.Lock()


def _float32_to_int16(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, a_min=-1.0, a_max=1.0)
    return (x * 32767.0).astype(np.int16)


def _int16_to_float32(x: np.ndarray) -> np.ndarray:
    return (x / 32767.0).astype(np.float32)


def quantize(audio: np.ndarray) -> np.ndarray:
    """Round-trip through int16, matching LAION-CLAP's expected input scaling.

    The reference implementation quantizes before embedding; skipping this
    produces embeddings that are subtly off-distribution from the ones the
    checkpoint was trained to emit.
    """
    return _int16_to_float32(_float32_to_int16(audio))


def load_model():
    """Load the CLAP checkpoint once, process-wide. Safe to call repeatedly."""
    global _model
    if _model is not None:
        return _model

    with _model_lock:
        if _model is not None:
            return _model

        import laion_clap  # imported lazily so module import stays cheap
        import torch

        # Cap intra-op threads. Without this, torch grabs every core and
        # contends with the librosa/essentia work running in sibling threads.
        torch.set_num_threads(max(1, (os.cpu_count() or 4) // 2))

        logger.info("Loading CLAP checkpoint from %s (amodel=%s)", _CHECKPOINT_PATH, _AUDIO_MODEL)
        model = laion_clap.CLAP_Module(enable_fusion=False, amodel=_AUDIO_MODEL)
        model.load_ckpt(_CHECKPOINT_PATH)
        model.eval()

        _model = model
        logger.info("CLAP checkpoint loaded")
        return _model


def is_loaded() -> bool:
    return _model is not None


def plan_windows(
    duration_s: float,
    window_s: float = DEFAULT_WINDOW_S,
    hop_s: float = DEFAULT_HOP_S,
) -> list[tuple[float, float]]:
    """Sliding [start, end) windows covering `duration_s`.

    Always returns at least one window. The final window is clamped to the end
    of the audio rather than zero-padded past it, and a trailing window is
    skipped when it would duplicate coverage the previous one already has.
    """
    if duration_s <= 0:
        return []
    if duration_s <= window_s:
        return [(0.0, duration_s)]

    windows: list[tuple[float, float]] = []
    start = 0.0
    while start < duration_s:
        end = min(start + window_s, duration_s)
        windows.append((start, end))
        if end >= duration_s:
            break
        start += hop_s

    return windows


def embed_audio_windows(
    y: np.ndarray,
    sr: int,
    windows: list[tuple[float, float]],
) -> np.ndarray:
    """Embed each [start, end) window. Returns an (n_windows, 512) L2-normalized array.

    `y` must already be mono at CLAP_SAMPLE_RATE.
    """
    if not windows:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)

    model = load_model()

    clips: list[np.ndarray] = []
    target_len = int(DEFAULT_WINDOW_S * sr)
    for start_s, end_s in windows:
        clip = y[int(start_s * sr) : int(end_s * sr)]
        # CLAP expects fixed-length input; short tails are zero-padded so the
        # final partial window is still embeddable.
        if len(clip) < target_len:
            clip = np.pad(clip, (0, target_len - len(clip)))
        clips.append(quantize(clip[:target_len]))

    out: list[np.ndarray] = []
    for i in range(0, len(clips), BATCH_SIZE):
        batch = np.stack(clips[i : i + BATCH_SIZE]).astype(np.float32)
        embeddings = model.get_audio_embedding_from_data(x=batch, use_tensor=False)
        out.append(np.asarray(embeddings, dtype=np.float32))

    stacked = np.vstack(out)
    return _l2_normalize(stacked)


def embed_text(texts: list[str]) -> np.ndarray:
    """Embed natural-language descriptions into the shared audio/text space.

    Returns an (n_texts, 512) L2-normalized array directly comparable by cosine
    similarity to the audio embeddings above.
    """
    if not texts:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)

    model = load_model()
    embeddings = model.get_text_embedding(texts, use_tensor=False)
    return _l2_normalize(np.asarray(embeddings, dtype=np.float32))


def _l2_normalize(matrix: np.ndarray) -> np.ndarray:
    """Row-wise L2 normalization, so pgvector cosine distance is well-behaved."""
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-8)
    return matrix / norms
