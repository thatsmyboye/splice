"""
Splice — AcousticBrainz Bulk Import Script
==========================================
One-time import of pre-computed audio features from the AcousticBrainz
data dump into Supabase track_features table.

Usage:
  python import_acousticbrainz.py \
    --input acousticbrainz-lowlevel-features.csv \
    --supabase-url https://xxx.supabase.co \
    --supabase-key <service_role_key> \
    --limit 500000

Download the CSV dump from: https://acousticbrainz.org/download
  File: lowlevel CSV (not the full JSON dump — much smaller)

Prerequisites:
  pip install supabase numpy tqdm pandas

Runtime: ~30–60 min for 500K rows. Batch size = 500 rows.
Progress is logged every 1000 rows. Safe to restart — duplicate
spotify_ids are skipped via ON CONFLICT DO NOTHING.
"""

import argparse
import json
import logging
import sys
import time
from typing import Optional

import numpy as np
import pandas as pd
from supabase import create_client, Client
from tqdm import tqdm

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s"
)
logger = logging.getLogger(__name__)

EMBEDDING_DIM = 128
BATCH_SIZE = 500

# AcousticBrainz CSV low-level column names
# (subset we care about from the lowlevel CSV dump)
AB_COLUMNS = {
    "mbid": str,
    "average_loudness": float,
    "dynamic_complexity": float,
    "bpm": float,
    "danceability": float,
    "mfcc_zero_mean": str,      # JSON array string
    "chords_key": str,
    "chords_scale": str,
}


def parse_args():
    parser = argparse.ArgumentParser(description="Import AcousticBrainz data to Supabase")
    parser.add_argument("--input", required=True, help="Path to AcousticBrainz lowlevel CSV")
    parser.add_argument("--supabase-url", required=True)
    parser.add_argument("--supabase-key", required=True, help="Service role key")
    parser.add_argument("--limit", type=int, default=500_000)
    parser.add_argument("--offset", type=int, default=0, help="Skip N rows (for resuming)")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    return parser.parse_args()


def build_embedding_from_ab(row: pd.Series) -> Optional[np.ndarray]:
    """
    Build a 128-dim embedding from AcousticBrainz low-level CSV row.
    This is a simpler version than the live analysis pipeline since
    we only have aggregated (not segment-level) features in the CSV dump.
    """
    try:
        features = []

        # BPM normalized (60–200 range → 0–1)
        bpm = float(row.get("bpm", 120))
        features.append(np.clip((bpm - 60) / 140, 0.0, 1.0))

        # Danceability (already 0–3, normalize to 0–1)
        dance = float(row.get("danceability", 1.5))
        features.append(np.clip(dance / 3.0, 0.0, 1.0))

        # Loudness (normalize -60 to 0 dB → 0–1)
        loudness = float(row.get("average_loudness", 0.5))
        features.append(np.clip(loudness, 0.0, 1.0))

        # Dynamic complexity (normalize 0–10 range)
        complexity = float(row.get("dynamic_complexity", 5.0))
        features.append(np.clip(complexity / 10.0, 0.0, 1.0))

        # MFCC zero mean (13 values from JSON string)
        mfcc_raw = row.get("mfcc_zero_mean", "[]")
        try:
            mfcc = json.loads(mfcc_raw) if isinstance(mfcc_raw, str) else mfcc_raw
            mfcc = np.array(mfcc[:13], dtype=float)
            if len(mfcc) < 13:
                mfcc = np.pad(mfcc, (0, 13 - len(mfcc)))
            # Normalize MFCC to roughly 0–1 range
            mfcc_norm = (mfcc - mfcc.min()) / (mfcc.max() - mfcc.min() + 1e-8)
        except Exception:
            mfcc_norm = np.zeros(13)
        features.extend(mfcc_norm.tolist())   # 13 dims

        # Key encoding: one-hot over 12 pitch classes (12 dims)
        key_map = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
                   "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
        key_one_hot = np.zeros(12)
        key_str = str(row.get("chords_key", "C"))
        key_idx = key_map.get(key_str, 0)
        key_one_hot[key_idx] = 1.0
        features.extend(key_one_hot.tolist())   # 12 dims

        # Mode: major=1, minor=0 (1 dim)
        mode = 1.0 if str(row.get("chords_scale", "major")).lower() == "major" else 0.0
        features.append(mode)   # 1 dim

        # Total so far: 1+1+1+1+13+12+1 = 30 dims
        # Pad to 128 with zeros (insufficient data from CSV — live analysis is richer)
        embedding = np.array(features, dtype=float)
        embedding = np.pad(embedding, (0, EMBEDDING_DIM - len(embedding)))

        # L2 normalize
        norm = np.linalg.norm(embedding)
        if norm > 1e-8:
            embedding = embedding / norm

        return embedding

    except Exception as e:
        logger.warning(f"Embedding build failed: {e}")
        return None


def build_minimal_segments(row: pd.Series) -> list:
    """
    AcousticBrainz CSV doesn't have segment data.
    Return a single synthetic segment covering the whole track
    with available aggregated features.
    """
    return [{
        "start_s": 0.0,
        "duration_s": 30.0,          # 30s preview assumed
        "energy": float(row.get("average_loudness", 0.5)),
        "loudness_db": float(row.get("average_loudness", -20)) * -40,
        "spectral_centroid": 0.5,    # not available in CSV dump
        "chroma_vector": [1/12] * 12,  # flat chroma (unknown)
        "mfcc_means": [0.0] * 13,   # zero (CSV has only zero-mean coefficient)
        "source": "acousticbrainz_csv"
    }]


def import_batch(supabase: Client, rows: list[dict]) -> tuple[int, int]:
    """Insert a batch. Returns (success_count, skip_count)."""
    try:
        result = supabase.table("track_features").upsert(
            rows,
            on_conflict="spotify_id",
            ignore_duplicates=True
        ).execute()
        return len(rows), 0
    except Exception as e:
        logger.error(f"Batch insert failed: {e}")
        return 0, len(rows)


def main():
    args = parse_args()

    logger.info(f"Connecting to Supabase: {args.supabase_url}")
    supabase: Client = create_client(args.supabase_url, args.supabase_key)

    logger.info(f"Loading CSV: {args.input}")
    logger.info("This may take a few minutes for large files...")

    # Load in chunks to avoid memory issues
    chunk_size = 10_000
    total_processed = 0
    total_success = 0
    total_skipped = 0
    batch_rows = []

    try:
        chunks = pd.read_csv(
            args.input,
            chunksize=chunk_size,
            skiprows=range(1, args.offset + 1) if args.offset > 0 else None,
            nrows=args.limit,
            dtype=str,              # read all as string, cast in build_embedding
            on_bad_lines="skip",
        )

        with tqdm(total=args.limit, desc="Importing") as pbar:
            for chunk in chunks:
                for _, row in chunk.iterrows():
                    if total_processed >= args.limit:
                        break

                    mbid = str(row.get("mbid", "")).strip()
                    if not mbid or mbid == "nan":
                        pbar.update(1)
                        continue

                    embedding = build_embedding_from_ab(row)
                    if embedding is None:
                        pbar.update(1)
                        continue

                    segments = build_minimal_segments(row)

                    record = {
                        "spotify_id": f"ab:{mbid}",    # Prefixed — no spotify ID in AB CSV
                        "mbid": mbid,
                        "source": "acousticbrainz",
                        "analysis_version": "1.0",
                        "segments": json.dumps(segments),
                        "bpm": float(row.get("bpm", 120) or 120),
                        "key_name": str(row.get("chords_key", "C")),
                        "key_mode": str(row.get("chords_scale", "major")),
                        "danceability": float(row.get("danceability", 0.5) or 0.5),
                        "dynamic_complexity": float(row.get("dynamic_complexity", 5.0) or 5.0),
                        "embedding": embedding.tolist(),
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

        # Flush remaining
        if batch_rows:
            success, skipped = import_batch(supabase, batch_rows)
            total_success += success
            total_skipped += skipped

    except FileNotFoundError:
        logger.error(f"Input file not found: {args.input}")
        sys.exit(1)
    except KeyboardInterrupt:
        logger.info("Import interrupted by user")
        if batch_rows:
            logger.info(f"Flushing final {len(batch_rows)} rows...")
            import_batch(supabase, batch_rows)

    logger.info("=" * 50)
    logger.info(f"Import complete.")
    logger.info(f"  Processed: {total_processed:,}")
    logger.info(f"  Imported:  {total_success:,}")
    logger.info(f"  Skipped:   {total_skipped:,}")
    logger.info("=" * 50)
    logger.info("Next: verify with:")
    logger.info("  SELECT count(*) FROM track_features WHERE source = 'acousticbrainz';")


if __name__ == "__main__":
    main()
