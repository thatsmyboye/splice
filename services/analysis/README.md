# Splice Analysis Service

FastAPI microservice for audio feature extraction. Deployed on Railway via Docker.

## Local Development

```bash
cd services/analysis

# Create virtualenv
python -m venv .venv
source .venv/bin/activate   # or .venv\Scripts\activate on Windows

# Install deps (takes a few minutes — essentia is large)
pip install -r requirements.txt

# Set env vars
cp .env.example .env
# Edit .env: set ANALYSIS_SERVICE_SECRET to any string for local dev

# Run
uvicorn main:app --reload --port 8000
```

Test it:
```bash
curl -X POST http://localhost:8000/analyze \
  -H "Content-Type: application/json" \
  -H "X-Service-Secret: your_secret_here" \
  -d '{"preview_url": "https://p.scdn.co/mp3-preview/...", "spotify_id": "test123"}'
```

## Railway Deployment

1. Push this repo to GitHub
2. railway.app → New Project → Deploy from GitHub
3. Set root directory to `services/analysis`
4. Railway detects Dockerfile automatically
5. Set environment variables in Railway dashboard:
   - `ANALYSIS_SERVICE_SECRET` — must match the value in `apps/web/.env.local`
   - `PORT=8000`
6. Copy the generated domain → set as `ANALYSIS_SERVICE_URL` in web app

## AcousticBrainz Bulk Import

One-time setup that pre-populates `track_features` with ~500K tracks so the app
has a searchable corpus before any user triggers on-demand analysis.

### Prerequisites

```bash
pip install supabase numpy tqdm
# zstd is required to extract the archives:
# macOS:  brew install zstd
# Ubuntu: sudo apt install zstd
```

### Step 1 — Download the archive(s)

The low-level JSON dump lives at:
```
https://data.metabrainz.org/pub/musicbrainz/acousticbrainz/dumps/acousticbrainz-lowlevel-json-20220623/
```

There are 29 files (`json-0` through `json-28`), each ~120 GB uncompressed.
**You only need 1–2 files** for a 500K-track corpus.

- For a quick start, download `json-0` (~120 GB uncompressed, ~30–40 GB compressed).
- For broader MBID coverage, also grab `json-14` (the midpoint of the range).

```bash
# Example — adjust filename/URL as needed
wget https://data.metabrainz.org/pub/musicbrainz/acousticbrainz/dumps/acousticbrainz-lowlevel-json-20220623/acousticbrainz-lowlevel-json-20220623-json-0.tar.zst
```

### Step 2 — Extract

```bash
tar --use-compress-program=unzstd \
    -xf acousticbrainz-lowlevel-json-20220623-json-0.tar.zst
```

This creates a directory tree organized by MBID:
```
0/
  00/
    00xxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.json
  01/
    ...
```

Each `.json` file is one AcousticBrainz recording submission containing the
full low-level feature output from Essentia.

### Step 3 — Run the import

```bash
python import_acousticbrainz.py \
  --input ./acousticbrainz-lowlevel-json-20220623-json-0 \
  --supabase-url https://YOUR_PROJECT.supabase.co \
  --supabase-key YOUR_SERVICE_ROLE_KEY \
  --limit 500000
```

Options:

| Flag | Default | Description |
|---|---|---|
| `--limit N` | 500000 | Stop after N records |
| `--offset N` | 0 | Skip first N files (resume an interrupted run) |
| `--batch-size N` | 500 | Rows per Supabase upsert call |

Runtime: ~60–120 min for 500K rows. The script is safe to interrupt and
resume — records are upserted on `mbid`, so duplicates are silently skipped.

### Step 4 — Verify

Run in the Supabase SQL editor:

```sql
SELECT
  count(*)          AS total,
  source,
  min(created_at)   AS first_imported,
  max(created_at)   AS last_imported
FROM track_features
GROUP BY source;
```

Expected: `~500000` rows with `source = 'acousticbrainz'`.

### Notes on the import

- **Which files to download**: each archive covers MBIDs whose leading hex
  character falls in a particular range. `json-0` contains MBIDs starting with
  `0x`; `json-14` covers roughly `ex`. Any single archive contains well over
  500K recordings, so one file is sufficient for an initial corpus.

- **Embedding quality**: the JSON import uses the full Essentia low-level
  feature set (MFCC, GFCC, chroma, bark bands, spectral contrast, etc.) to
  build genuine 128-dim embeddings. This is significantly richer than the old
  CSV-based import, which only had ~30 real dimensions.

- **Multiple submissions**: AcousticBrainz sometimes has several submissions for
  the same MBID (e.g. `{mbid}-0.json`, `{mbid}-1.json`). The importer keeps
  only submission `0` (the most-played version) and ignores the rest.

- **Spotify linkage**: imported rows use `spotify_id = "ab:{mbid}"` as a
  placeholder. When a user searches for a Spotify track, the app looks up the
  corresponding MusicBrainz recording ID and joins on `mbid` to find the
  pre-indexed features. If no match is found, on-demand analysis via the
  Spotify 30s preview URL is triggered instead.

- **analysis_version**: rows imported by this script are tagged `2.0`. If you
  re-run the import after a schema change, bump this value so you can
  distinguish old rows.

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | /health | Health check |
| POST | /analyze | Analyze a 30s audio preview URL |
| POST | /embed | Convert a MomentDescriptor to a 128-dim vector |

All non-health endpoints require `X-Service-Secret` header.
