# Splice Analysis Service

FastAPI microservice that turns audio into **moment embeddings** — the vectors
pgvector searches — plus display metadata. Deployed on Railway via Docker.

## Local Development

```bash
cd services/analysis

# Create virtualenv
python -m venv .venv
source .venv/bin/activate   # or .venv\Scripts\activate on Windows

# Install deps (slow — essentia is large, and torch/CLAP add ~2GB)
pip install --index-url https://download.pytorch.org/whl/cpu torch==2.2.2 torchaudio==2.2.2
pip install -r requirements.txt

# Fetch the CLAP checkpoint (~2.35GB) and point CLAP_CHECKPOINT_PATH at it
curl -fsSL -o ./music_audioset_epoch_15_esc_90.14.pt \
  https://huggingface.co/lukewys/laion_clap/resolve/main/music_audioset_epoch_15_esc_90.14.pt

# Set env vars
cp .env.example .env
# Edit .env: ANALYSIS_SERVICE_SECRET can be any string for local dev.
# Set CLAP_CHECKPOINT_PATH to wherever you saved the .pt file above.

# Run. Startup loads the checkpoint before serving, so the first boot is slow
# and a missing/corrupt checkpoint fails loudly here rather than mid-request.
uvicorn main:app --reload --port 8000
```

Check it came up in the right embedding space:
```bash
curl http://localhost:8000/health
# {"status":"ok","embedding_model":"clap-music-audioset-v1","model_loaded":true,...}
```

Analyze a preview:
```bash
curl -X POST http://localhost:8000/analyze \
  -H "Content-Type: application/json" \
  -H "X-Service-Secret: your_secret_here" \
  -d '{"audio_url": "https://example.com/preview.mp3", "spotify_id": "test123"}'
```

Analyze a local full-length file:
```bash
curl -X POST http://localhost:8000/analyze-upload \
  -H "X-Service-Secret: your_secret_here" \
  -F "file=@/path/to/track.mp3" \
  -F "spotify_id=test123"
```

## Railway Deployment

1. Push this repo to GitHub
2. railway.app → New Project → Deploy from GitHub
3. Set root directory to `services/analysis`
4. Railway detects Dockerfile automatically
5. Set environment variables in Railway dashboard:
   - `ANALYSIS_SERVICE_SECRET` — must match the value in `apps/web/.env.local`
   - `PORT=8000`
   - `ANALYSIS_CONCURRENCY` — see "Memory and concurrency" below
6. Copy the generated domain → set as `ANALYSIS_SERVICE_URL` in web app
7. Verify before seeding anything: `curl $ANALYSIS_SERVICE_URL/health` should
   report `model_loaded: true` and the expected `embedding_model`

## Embedding Model

Moment search runs on **LAION-CLAP** (`music_audioset_epoch_15_esc_90.14.pt`),
which produces 512-dim vectors in a space shared by audio *and* text.

Two consequences worth internalising:

- A typed description ("the bit where everything drops out") can be embedded
  with `/embed-text` and matched against catalog audio directly. No LLM sits in
  the retrieval path.
- `EMBEDDING_MODEL_ID` in `main.py` labels every vector this service emits.
  **Change the checkpoint, change that ID, and re-seed.** Vectors from two
  checkpoints are not comparable by cosine similarity, and mixing them does not
  raise an error — it just returns confident nonsense. That failure is exactly
  what made the old AcousticBrainz catalog useless.

The librosa/essentia pass still runs, but only for **display metadata** (key,
BPM, time signature, per-section chords). It never contributes to search.

## Windows, not tracks

`/analyze` returns a sliding window over the audio — 10s wide, 5s hop — each
with its own embedding and `[start_s, end_s)`. The web app stores these in
`moment_embeddings`, so a search hit carries a real timestamp instead of the
API having to invent one.

CLAP's audio encoder natively consumes ~10s chunks, which is where the window
size comes from; the 50% overlap keeps a moment that straddles a boundary near
the centre of at least one window.

## Memory and concurrency

> ⚠️ **Run exactly one uvicorn worker.**

The checkpoint is ~2GB resident and each worker is a separate process with its
own copy. The Dockerfile previously ran `--workers 16`, which would have needed
roughly 32GB of RAM. Real parallelism comes from `ANALYSIS_CONCURRENCY`, a
semaphore over a threadpool inside the single process — the right shape anyway,
since analysis is CPU-bound rather than IO-bound.

The image is large (CPU-only torch plus the baked-in 2.35GB checkpoint,
~5-6GB total). If that exceeds your Railway build limits, drop the `curl` step
from the Dockerfile and mount the checkpoint from a volume instead, pointing
`CLAP_CHECKPOINT_PATH` at it.

## Legacy: AcousticBrainz import

`import_acousticbrainz.py` is **retired**. Its data is track-level aggregates
only (the import fabricated a single full-track "segment"), and it embedded into
a different space than this service produces. Both problems are fatal for moment
matching. The catalog is now built by `apps/web/scripts/seed-catalog.ts`, which
runs seed tracks through the same `/analyze` endpoint that serves live searches.

Do not reintroduce it.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | /health | Health check; reports `embedding_model` and whether the checkpoint is loaded |
| POST | /analyze | Audio URL (`preview_url` or `audio_url`) -> windowed embeddings + display metadata |
| POST | /analyze-upload | Same, from a multipart file. Used for full-length user-supplied tracks; bytes are never persisted |
| POST | /embed-text | Description -> 512-dim vector in the shared audio/text space |

All non-health endpoints require the `X-Service-Secret` header.
