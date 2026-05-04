"""
Splice — AcousticBrainz Bulk Import Script (JSON format)
=========================================================
Imports pre-computed audio features from AcousticBrainz low-level JSON dumps
into Supabase track_features table.

Usage:
  python import_acousticbrainz.py \\
    --input /path/to/extracted-archive-dir \\
    --supabase-url https://xxx.supabase.co \\
    --supabase-key <service_role_key> \\
    --limit 500000

The --input directory should be the extracted contents of one or more
acousticbrainz-lowlevel-json-20220623-json-N.tar.zst archives.
Each archive extracts to a tree of the form:
  {mbid[0]}/{mbid[0:2]}/{mbid}.json

Prerequisites:
  pip install supabase numpy tqdm

Runtime: ~60–120 min for 500K rows. Safe to restart — duplicate MBIDs are
skipped via ON CONFLICT DO NOTHING.

128-dim embedding layout:
  0–12:   MFCC means (13)         timbral character
  13–25:  MFCC vars (13)          timbral variation
  26–38:  GFCC means (13)         gammatone-based timbre
  39–50:  chroma means (12)       harmonic content
  51–62:  chroma vars (12)        harmonic variation
  63–89:  bark band means (27)    spectral envelope shape
  90–99:  spectral features (10)  brightness, flux, texture, noise (mean+var pairs)
  100–103: rhythm (4)             BPM, danceability, onset rate, beat count
  104–105: dynamics (2)           loudness, dynamic complexity
  106–117: key one-hot (12)       tonal center
  118:    mode (1)                major=1, minor=0
  119:    key strength (1)        tonal confidence
  120:    chord change rate (1)   harmonic rhythm
  121:    HFC (1)                 high-frequency content
  122:    RMS (1)                 spectral energy
  123–127: spectral contrast (5)  tonal vs. noise contrast per band
"""

import argparse
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Iterator, Optional

import numpy as np
from supabase import create_client, Client
from tqdm import tqdm

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

EMBEDDING_DIM = 128
BATCH_SIZE = 500

KEY_MAP = {
    "C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
    "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11,
}
MBID_RE = re.compile(
    r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import AcousticBrainz low-level JSON data into Supabase"
    )
    parser.add_argument(
        "--input", required=True,
        help="Path to extracted AcousticBrainz JSON directory (or a single .json file for testing)",
    )
    parser.add_argument("--supabase-url", required=True)
    parser.add_argument("--supabase-key", required=True, help="Service role key")
    parser.add_argument("--limit", type=int, default=500_000, help="Max records to import")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--offset", type=int, default=0, help="Skip first N files (for resuming)")
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Low-level feature helpers
# ---------------------------------------------------------------------------

def _get_mean(section: dict, key: str, size: int) -> np.ndarray:
    """Extract a .mean array from a feature dict, padding/truncating to size."""
    sub = section.get(key, {})
    if isinstance(sub, dict):
        arr = sub.get("mean", [])
    elif isinstance(sub, list):
        arr = sub
    else:
        arr = []
    out = np.array(arr, dtype=np.float64)
    if len(out) < size:
        out = np.pad(out, (0, size - len(out)))
    return out[:size]


def _get_var(section: dict, key: str, size: int) -> np.ndarray:
    """Extract a .var array from a feature dict, padding/truncating to size."""
    sub = section.get(key, {})
    if isinstance(sub, dict):
        arr = sub.get("var", sub.get("stdev", []))
    else:
        arr = []
    out = np.array(arr, dtype=np.float64)
    if len(out) < size:
        out = np.pad(out, (0, size - len(out)))
    return out[:size]


def _stat(section: dict, key: str, stat: str = "mean", default: float = 0.0) -> float:
    """Get a single named statistic from a feature dict."""
    sub = section.get(key, {})
    if isinstance(sub, dict):
        val = sub.get(stat, default)
    elif stat == "mean":
        val = sub
    else:
        return default
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _clip01(arr: np.ndarray) -> np.ndarray:
    return np.clip(arr, 0.0, 1.0)


def _log_norm(arr: np.ndarray, eps: float = 1e-6) -> np.ndarray:
    """Log-normalize a non-negative array to [0, 1]."""
    arr = np.maximum(arr, 0.0) + eps
    arr = np.log(arr)
    lo, hi = arr.min(), arr.max()
    if hi - lo > eps:
        return (arr - lo) / (hi - lo)
    return np.zeros_like(arr)


# ---------------------------------------------------------------------------
# Embedding builder
# ---------------------------------------------------------------------------

def build_embedding(data: dict) -> Optional[np.ndarray]:
    """Build a 128-dim L2-normalized embedding from AcousticBrainz low-level JSON."""
    try:
        ll = data.get("lowlevel", {})
        rh = data.get("rhythm", {})
        to = data.get("tonal", {})

        features: list[float] = []

        # MFCC means (13): typical range roughly [-100, 100]
        mfcc_mean = _get_mean(ll, "mfcc", 13)
        features.extend(_clip01((mfcc_mean + 100.0) / 200.0).tolist())

        # MFCC vars (13): log-normalize non-negative variance
        mfcc_var = _get_var(ll, "mfcc", 13)
        features.extend(_log_norm(mfcc_var).tolist())

        # GFCC means (13): gammatone cepstral — similar range to MFCC
        gfcc_mean = _get_mean(ll, "gfcc", 13)
        features.extend(_clip01((gfcc_mean + 100.0) / 200.0).tolist())

        # Chroma means (12): essentia outputs 0–1
        chroma_mean = _get_mean(ll, "chroma_cens", 12)
        if chroma_mean.sum() < 1e-6:
            chroma_mean = _get_mean(ll, "chroma_stft", 12)
        features.extend(_clip01(chroma_mean).tolist())

        # Chroma vars (12): log-normalize
        chroma_var = _get_var(ll, "chroma_cens", 12)
        if chroma_var.sum() < 1e-6:
            chroma_var = _get_var(ll, "chroma_stft", 12)
        features.extend(_log_norm(chroma_var).tolist())

        # Bark band means (27): log-normalize spectral energy envelope
        bark_mean = _get_mean(ll, "barkbands", 27)
        features.extend(_log_norm(bark_mean).tolist())

        # Spectral features — 5 descriptors × (mean + var) = 10 dims
        for feat_key, mean_scale, var_scale in [
            ("spectral_centroid",   8000.0, 15.0),   # Hz
            ("spectral_rolloff",    8000.0, 15.0),   # Hz
            ("spectral_flux",       0.05,   5.0),    # already small
            ("spectral_complexity", 30.0,   5.0),    # 0–30 typical
            ("zerocrossingrate",    0.1,    5.0),    # 0–0.5 typical
        ]:
            mean_val = _stat(ll, feat_key, "mean")
            var_val  = _stat(ll, feat_key, "var")
            features.append(float(np.clip(mean_val / mean_scale, 0.0, 1.0)))
            features.append(float(np.clip(np.log1p(abs(var_val)) / var_scale, 0.0, 1.0)))

        # Rhythm (4)
        # Use explicit None checks so valid zero values (e.g. danceability=0, onset_rate=0)
        # are not silently replaced by the `or` fallback. BPM and beats_count cannot
        # meaningfully be 0, so the `or` fallback is still correct for those two.
        _bpm         = rh.get("bpm")
        _dance       = rh.get("danceability")
        _onset       = rh.get("onset_rate")
        _beats       = rh.get("beats_count")
        bpm          = float(_bpm   if _bpm   is not None and _bpm   != 0 else 120.0)
        danceability = float(_dance if _dance is not None              else 1.5)
        onset_rate   = float(_onset if _onset is not None              else 5.0)
        beats_count  = float(_beats if _beats is not None and _beats  != 0 else 100)
        features.extend([
            float(np.clip((bpm - 40.0) / 220.0, 0.0, 1.0)),
            float(np.clip(danceability / 3.0, 0.0, 1.0)),
            float(np.clip(onset_rate / 20.0, 0.0, 1.0)),
            float(np.clip(beats_count / 500.0, 0.0, 1.0)),
        ])

        # Dynamics (2)
        # loudness is in [0,1] so 0 is a valid value; dynamic_complexity can also be 0.
        _loudness    = ll.get("average_loudness")
        _dyn         = ll.get("dynamic_complexity")
        loudness           = float(_loudness if _loudness is not None else 0.5)
        dynamic_complexity = float(_dyn      if _dyn      is not None else 5.0)
        features.extend([
            float(np.clip(loudness, 0.0, 1.0)),
            float(np.clip(dynamic_complexity / 10.0, 0.0, 1.0)),
        ])

        # Key one-hot (12)
        key_one_hot = np.zeros(12)
        key_str = str(to.get("key_key", to.get("chords_key", "C")))
        key_one_hot[KEY_MAP.get(key_str, 0)] = 1.0
        features.extend(key_one_hot.tolist())

        # Mode, key strength, chord change rate (3)
        mode = 1.0 if str(to.get("key_scale", to.get("chords_scale", "major"))).lower() == "major" else 0.0
        _ks = to.get("key_strength")
        key_strength       = float(_ks if _ks is not None else 0.5)
        chord_change_rate  = float(to.get("chords_changes_rate") or 0.0)
        features.extend([
            mode,
            float(np.clip(key_strength, 0.0, 1.0)),
            float(np.clip(chord_change_rate * 5.0, 0.0, 1.0)),
        ])

        # HFC + RMS (2)
        hfc = _stat(ll, "hfc", "mean", 100.0)
        rms = _stat(ll, "spectral_rms", "mean", 0.1)
        features.extend([
            float(np.clip(np.log1p(hfc) / 10.0, 0.0, 1.0)),
            float(np.clip(rms * 10.0, 0.0, 1.0)),
        ])

        # Spectral contrast coefficients (5 of 6 bands): 0–50 dB range
        contrast = _get_mean(ll, "spectral_contrast_coeffs", 6)
        features.extend(_clip01(contrast[:5] / 50.0).tolist())

        assert len(features) == EMBEDDING_DIM, f"Expected {EMBEDDING_DIM} dims, got {len(features)}"

        embedding = np.array(features, dtype=np.float32)
        norm = np.linalg.norm(embedding)
        if norm > 1e-8:
            embedding = embedding / norm
        return embedding

    except Exception as e:
        logger.warning(f"Embedding build failed: {e}")
        return None


def build_segments(data: dict) -> list:
    """
    AcousticBrainz track-level data has no true segment boundaries.
    Return one synthetic segment covering the full preview duration,
    populated with the richest available aggregated features.
    """
    ll = data.get("lowlevel", {})
    rh = data.get("rhythm", {})
    audio_props = data.get("metadata", {}).get("audio_properties", {})

    duration = float(audio_props.get("length", 30.0) or 30.0)

    chroma = _get_mean(ll, "chroma_cens", 12)
    if chroma.sum() < 1e-6:
        chroma = _get_mean(ll, "chroma_stft", 12)

    mfcc = _get_mean(ll, "mfcc", 13)
    spectral_centroid_raw = _stat(ll, "spectral_centroid", "mean", 2000.0)
    loudness = float(ll.get("average_loudness", 0.5) or 0.5)

    return [{
        "start_s":          0.0,
        "duration_s":       min(duration, 30.0),
        "energy":           float(np.clip(loudness, 0.0, 1.0)),
        "loudness_db":      float(loudness * -40.0 + 20.0),
        "spectral_centroid": float(np.clip(spectral_centroid_raw / 8000.0, 0.0, 1.0)),
        "chroma_vector":    chroma.tolist(),
        "mfcc_means":       mfcc.tolist(),
        "bpm":              float(rh.get("bpm", 120.0) or 120.0),
        "source":           "acousticbrainz_json",
    }]


# ---------------------------------------------------------------------------
# File iteration
# ---------------------------------------------------------------------------

def extract_mbid(path: Path) -> Optional[str]:
    """Extract the UUID from a filename like {mbid}.json or {mbid}-0.json."""
    match = MBID_RE.search(path.stem)
    return match.group(1).lower() if match else None


def iter_json_files(root: Path, offset: int = 0) -> Iterator[tuple[Path, str]]:
    """
    Walk root recursively, yielding (path, mbid) for every .json file.
    Files named {mbid}-N.json where N > 0 are alternate submissions for the
    same recording; we skip them and keep only the first submission (N == 0
    or no suffix), which AcousticBrainz marks as the most-played version.
    """
    skipped = 0
    for dirpath, _, filenames in os.walk(root):
        for filename in sorted(filenames):
            if not filename.endswith(".json"):
                continue

            path = Path(dirpath) / filename
            mbid = extract_mbid(path)
            if not mbid:
                continue

            # Skip non-primary submissions: {mbid}-1.json, {mbid}-2.json, ...
            stem = path.stem
            suffix_match = re.search(r"-(\d+)$", stem)
            if suffix_match and int(suffix_match.group(1)) > 0:
                continue

            if skipped < offset:
                skipped += 1
                continue

            yield path, mbid


# ---------------------------------------------------------------------------
# Supabase insertion
# ---------------------------------------------------------------------------

def import_batch(supabase: Client, rows: list[dict]) -> tuple[int, int]:
    """Upsert a batch. Returns (success_count, skip_count)."""
    try:
        supabase.table("track_features").upsert(
            rows,
            on_conflict="mbid",
            ignore_duplicates=True,
        ).execute()
        return len(rows), 0
    except Exception as e:
        logger.error(f"Batch upsert failed: {e}")
        return 0, len(rows)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    args = parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        logger.error(f"Input path does not exist: {input_path}")
        sys.exit(1)

    logger.info(f"Connecting to Supabase: {args.supabase_url}")
    supabase: Client = create_client(args.supabase_url, args.supabase_key)

    logger.info(f"Walking JSON files in: {input_path}")
    if args.offset:
        logger.info(f"Skipping first {args.offset:,} files (resuming)")

    total_processed = total_success = total_skipped = 0
    batch_rows: list[dict] = []

    file_iter = iter_json_files(input_path, offset=args.offset) if input_path.is_dir() else iter([( input_path, extract_mbid(input_path))])

    with tqdm(total=args.limit, desc="Importing", unit="tracks") as pbar:
        for json_path, mbid in file_iter:
            if total_processed >= args.limit:
                break

            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except (json.JSONDecodeError, OSError) as e:
                logger.debug(f"Skipping {json_path.name}: {e}")
                continue

            embedding = build_embedding(data)
            if embedding is None:
                continue

            ll = data.get("lowlevel", {})
            rh = data.get("rhythm", {})
            to = data.get("tonal", {})
            segments = build_segments(data)

            record = {
                "spotify_id":         f"ab:{mbid}",
                "mbid":               mbid,
                "source":             "acousticbrainz",
                "analysis_version":   "2.0",
                "segments":           json.dumps(segments),
                "bpm":                float(rh.get("bpm", 120.0) or 120.0),
                "key_name":           str(to.get("key_key", to.get("chords_key", "C"))),
                "key_mode":           str(to.get("key_scale", to.get("chords_scale", "major"))),
                "danceability":       float(rh.get("danceability", 0.5) or 0.5),
                "dynamic_complexity": float(ll.get("dynamic_complexity", 5.0) or 5.0),
                "embedding":          embedding.tolist(),
            }

            batch_rows.append(record)
            total_processed += 1
            pbar.update(1)

            if len(batch_rows) >= args.batch_size:
                success, skipped = import_batch(supabase, batch_rows)
                total_success += success
                total_skipped += skipped
                batch_rows = []

                if total_processed % 10_000 == 0:
                    logger.info(
                        f"Progress: {total_processed:,} processed, "
                        f"{total_success:,} imported, "
                        f"{total_skipped:,} skipped"
                    )

    if batch_rows:
        success, skipped = import_batch(supabase, batch_rows)
        total_success += success
        total_skipped += skipped

    logger.info("=" * 50)
    logger.info("Import complete.")
    logger.info(f"  Processed : {total_processed:,}")
    logger.info(f"  Imported  : {total_success:,}")
    logger.info(f"  Skipped   : {total_skipped:,}")
    logger.info("=" * 50)
    logger.info("Verify with:")
    logger.info("  SELECT count(*) FROM track_features WHERE source = 'acousticbrainz';")


if __name__ == "__main__":
    main()
