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

## Building initial catalog coverage

**Bulk-seed script (current approach)** — populates `track_features` before
launch by running a diverse list of tracks through the *same* on-demand
librosa/essentia pipeline (`services/analysis/main.py`) that handles live user
searches. See `apps/web/scripts/seed-catalog.ts`. Because every row is built
by one embedding function, there's no cross-space comparison problem, and
every seeded track has genuine per-segment (moment-level) features — not
just track-level aggregates.

**AcousticBrainz import (legacy, not recommended)** — `services/analysis/import_acousticbrainz.py`
imports AcousticBrainz's pre-computed low-level features in bulk. This was
the original cold-start plan, but AcousticBrainz only has track-level
aggregate stats (no real segments — `build_segments()` fabricates one
synthetic full-track segment per recording), and its 128-dim embedding layout
is built completely differently from the live analysis service's layout
(see `import_acousticbrainz.py`'s docstring vs. `main.py`'s `build_embedding()`).
Rows from the two sources are not directly comparable by cosine similarity.
The script and `services/analysis/README.md` instructions are kept for
reference but are superseded by the bulk-seed script above.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | /health | Health check |
| POST | /analyze | Analyze a 30s audio preview URL |
| POST | /embed | Convert a MomentDescriptor to a 64-dim vector |

All non-health endpoints require `X-Service-Secret` header.
