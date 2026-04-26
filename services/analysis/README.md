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

### Prerequisites
```bash
pip install supabase pandas tqdm
```

### Download the data
Go to https://acousticbrainz.org/download

Download the **lowlevel CSV** file:
- `acousticbrainz-lowlevel-features.tar.bz2` (~2GB compressed, ~8GB uncompressed)

Extract:
```bash
tar -xjf acousticbrainz-lowlevel-features.tar.bz2
```

### Run the import
```bash
python import_acousticbrainz.py \
  --input acousticbrainz-lowlevel-features.csv \
  --supabase-url https://YOUR_PROJECT.supabase.co \
  --supabase-key YOUR_SERVICE_ROLE_KEY \
  --limit 500000
```

Options:
- `--limit N`: import at most N rows (default 500K)
- `--offset N`: skip first N rows (useful for resuming interrupted imports)
- `--batch-size N`: rows per Supabase batch insert (default 500)

### Verify the import
In Supabase SQL editor:
```sql
SELECT
  count(*) as total,
  source,
  min(created_at) as first_imported,
  max(created_at) as last_imported
FROM track_features
GROUP BY source;
```

### Notes on the AB data
- AcousticBrainz CSV dump contains track-level aggregates only (no segments)
- MBIDs in the AB dataset link to MusicBrainz recordings
- Tracks imported from AB use `spotify_id` prefixed with `ab:` (e.g. `ab:abc123-...mbid...`)
- When a user plays a Spotify track, the system checks for a matching MBID to find AB features,
  then falls back to on-demand analysis via Spotify 30s preview if no match found
- The embedding quality for AB tracks is lower than on-demand analysis (fewer features available)
  but still useful for cold-start catalog coverage

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | /health | Health check |
| POST | /analyze | Analyze a 30s audio preview URL |
| POST | /embed | Convert a MomentDescriptor to a 64-dim vector |

All non-health endpoints require `X-Service-Secret` header.
