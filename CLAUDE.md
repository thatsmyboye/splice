# Splice — CLAUDE.md

> Moment-first music discovery. Find songs that share the exact musical moment you love.

---

## Project Overview

Splice is a web application that lets users identify a specific moment in a song — a timestamp, a sonic texture, a structural event — and discover other songs that contain a similar moment. Discovery is driven by intra-song audio feature matching (segment-level), natural language moment interpretation via Claude, and vector similarity search via pgvector in Supabase.

This product is built as a solo indie project under the Banton Digital brand. It is a portfolio/showcase application, not a VC-backed startup. Decisions should optimize for build speed, demonstrability, and technical impressiveness — not enterprise scale.

---

## Monorepo Structure

```
splice/
├── CLAUDE.md                    ← you are here
├── .env.example                 ← all required env vars (no values)
├── package.json                 ← root workspace config
├── turbo.json                   ← Turborepo pipeline
├── pnpm-workspace.yaml
│
├── apps/
│   └── web/                     ← Next.js 14 frontend (App Router)
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── page.tsx         ← landing / search entry
│       │   ├── discover/
│       │   │   └── [trackId]/
│       │   │       └── page.tsx ← waveform scrubber + moment results
│       │   ├── library/
│       │   │   └── page.tsx     ← saved moments (auth required)
│       │   └── api/
│       │       ├── interpret/   ← Claude moment interpretation
│       │       ├── analyze/     ← triggers analysis service job
│       │       ├── match/       ← pgvector similarity query
│       │       └── auth/        ← Supabase auth callbacks
│       ├── components/
│       │   ├── waveform/        ← scrubber UI (WaveSurfer.js)
│       │   ├── moment-card/     ← result card showing matched moment
│       │   ├── search/          ← track search via Spotify embed search
│       │   └── ui/              ← shadcn/ui components
│       ├── lib/
│       │   ├── supabase/        ← client + server Supabase instances
│       │   ├── anthropic.ts     ← Claude API wrapper
│       │   └── spotify.ts       ← Spotify Web API (metadata only)
│       └── middleware.ts        ← auth route protection
│
├── packages/
│   ├── types/                   ← shared TypeScript types
│   ├── ui/                      ← shared component primitives
│   └── config/                  ← shared ESLint/TS config
│
└── services/
    └── analysis/                ← Python audio analysis microservice
        ├── main.py              ← FastAPI app
        ├── analyzer.py          ← librosa + essentia pipeline
        ├── requirements.txt
        ├── Dockerfile
        └── README.md
```

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Next.js 14 (App Router) | TypeScript, Tailwind, shadcn/ui |
| Auth | Supabase Auth | Google OAuth + magic link |
| Database | Supabase (PostgreSQL) | pgvector extension for similarity search |
| Background Jobs | Inngest | Analysis job queue |
| AI/LLM | Anthropic Claude API | `claude-sonnet-4-5` for moment interpretation |
| Audio Analysis | Python (librosa + essentia) | FastAPI microservice on Railway |
| Waveform UI | WaveSurfer.js | Scrubber + region selection |
| Music Metadata | Spotify Web API | Track search + metadata only (no audio analysis) |
| Music Catalog | AcousticBrainz data dump | Pre-indexed feature vectors in pgvector |
| Hosting | Vercel (web) + Railway (analysis service) |
| Package Manager | pnpm |
| Monorepo | Turborepo |

---

## Environment Variables

See `.env.example` for the full list. Summary:

### Web App (`apps/web/.env.local`)
```
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Anthropic
ANTHROPIC_API_KEY=

# Spotify (metadata only — no audio analysis scopes needed)
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=

# Analysis Service
ANALYSIS_SERVICE_URL=           # Railway deployment URL
ANALYSIS_SERVICE_SECRET=        # Shared secret for service auth

# Inngest
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=

# App
NEXT_PUBLIC_APP_URL=
```

### Analysis Service (`services/analysis/.env`)
```
ANALYSIS_SERVICE_SECRET=        # Must match web app value
PORT=8000
```

---

## Data Architecture

### Core Tables (Supabase)

```sql
-- users (managed by Supabase Auth, extended here)
-- moments: user-saved moment annotations
-- tracks: cached track metadata from Spotify
-- track_features: pre-indexed segment-level audio feature vectors
-- moment_matches: cached match results (TTL-based invalidation)
```

See `supabase/migrations/0001_initial_schema.sql` for full schema including pgvector setup.

### Audio Feature Vector Schema

Each track in `track_features` stores a JSONB array of segment descriptors plus a `embedding vector(128)` column for pgvector similarity search. The 128-dimensional embedding is derived from the AcousticBrainz low-level features (MFCC means, chroma, spectral centroid, etc.) normalized and PCA-reduced.

---

## Key Flows

### Flow 1: Song Search → Moment Selection

1. User searches for a track (Spotify search API → title/artist/album metadata)
2. Frontend loads the Spotify embed player for playback preview
3. WaveSurfer.js loads a waveform visualization (generated from Spotify 30s preview URL if available, or a static placeholder)
4. User either: (a) scrubs to a timestamp and clicks "This moment", or (b) types a natural language description of what they love

### Flow 2: Moment Interpretation (Claude)

1. `POST /api/interpret` receives: `{ trackId, timestamp?, description?, spotifyTrackData }`
2. Claude is given the track's metadata (title, artist, genre tags from MusicBrainz) and the user's input
3. Claude returns a structured `MomentDescriptor`: `{ energy_profile, timbral_character, harmonic_tension, structural_position, textural_density, emotional_arc }` — each field is a normalized 0–1 score plus a short label
4. This descriptor is stored and used to construct the pgvector query

### Flow 3: Audio Analysis (on-demand)

If a track is not yet in `track_features`:
1. Inngest job fires: `analysis/track.requested`
2. Analysis service receives the Spotify preview URL (30s MP3)
3. librosa extracts: segments, beats, sections, spectral features, chroma, MFCCs
4. essentia extracts: tonal key, danceability, dynamic complexity
5. Features are normalized, embedded into 128-dim vector, stored in Supabase
6. Frontend polls until analysis complete, then proceeds to matching

### Flow 4: Matching

1. `POST /api/match` receives the `MomentDescriptor` + source track's feature vector for the selected segment
2. pgvector `<=>` cosine similarity search over `track_features`
3. Results ranked by: vector similarity × Claude-scored moment relevance (a lightweight re-ranking step)
4. Each result card shows: track info, the timestamp of the matching moment, a one-line explanation of *why* it matches

---

## Claude API Usage

Model: `claude-sonnet-4-5`

### Moment Interpretation Prompt Pattern

```typescript
// See lib/anthropic.ts → interpretMoment()
// System: music analysis expert, returns only structured JSON
// User: track metadata + user description/timestamp context
// Output: MomentDescriptor JSON (validated with zod)
```

Claude is **never** used for:
- Generating audio features (librosa/essentia do this)
- Direct music recommendations (pgvector does this)
- Any streaming or real-time response (all calls are request/response)

Claude **is** used for:
- Translating natural language descriptions into structured feature descriptors
- Re-ranking/explaining match results with a one-line human-readable reason
- (Phase 2) Refining descriptors based on user feedback signals

---

## Spotify API — Critical Constraints

> ⚠️ Read before touching anything Spotify-related.

Spotify deprecated audio analysis endpoints on Nov 27, 2024. As of May 15, 2025, extended quota mode requires 250K MAU and an organization account. **Splice does not rely on Spotify for audio analysis.**

**What Splice uses Spotify for (all available in development mode):**
- Track search (`GET /search`)
- Track metadata (`GET /tracks/{id}`)
- 30-second preview URLs (embedded in track objects, no extra scope)
- Spotify Embed player (iframe, no API key required)

**What Splice does NOT use:**
- `/audio-features` (deprecated)
- `/audio-analysis` (deprecated/restricted)
- `/recommendations` (deprecated)
- Any playback control endpoints (Premium-only, out of scope)

Development mode allows up to 25 manually allowlisted users. This is sufficient for a portfolio app. Do not attempt to request extended quota.

---

## AcousticBrainz Data

AcousticBrainz is discontinued but its full data dump (29.4M submissions) remains publicly downloadable. Splice uses a **curated subset**: ~500K tracks from the low-level CSV dump, covering widely-known recordings with reliable MBID links to MusicBrainz metadata.

The import pipeline (`services/analysis/import_acousticbrainz.py`) handles:
1. Download the CSV dumps from acousticbrainz.org/download
2. Filter to tracks with high-confidence features
3. Normalize feature vectors
4. Batch-insert into Supabase `track_features` with pgvector embeddings

This is a one-time setup step. See `services/analysis/README.md` for instructions.

---

## Analysis Service (Python)

FastAPI microservice. Deployed on Railway (Docker).

**Endpoints:**
- `POST /analyze` — accepts a 30s audio URL, returns segment-level features
- `POST /embed` — converts a feature dict to a 128-dim normalized vector
- `GET /health` — health check

**Key libraries:**
- `librosa` — segment detection, spectral features, chroma, MFCCs
- `essentia` — tonal analysis, danceability, dynamic complexity
- `numpy`, `scipy` — normalization, PCA
- `fastapi`, `uvicorn` — API server
- `httpx` — async audio file fetching

Authentication: shared secret header (`X-Service-Secret`). Not public-facing.

---

## Development Setup

```bash
# Prerequisites: Node 20+, pnpm, Python 3.11+, Docker (for analysis service)

# Install dependencies
pnpm install

# Copy env files
cp .env.example apps/web/.env.local
cp services/analysis/.env.example services/analysis/.env
# → Fill in all values (see Manual Setup Checklist below)

# Run Supabase migrations
pnpm supabase db push

# Start web app (dev)
pnpm dev --filter web

# Start analysis service (dev)
cd services/analysis && pip install -r requirements.txt && uvicorn main:app --reload

# Or run everything via Docker Compose (recommended)
docker-compose up
```

---

## Manual Setup Checklist

> These steps cannot be completed through code. Each must be done manually before the app will run.

### 1. Supabase Project
- [ ] Create a new project at supabase.com
- [ ] Enable the `pgvector` extension: Dashboard → Database → Extensions → search "vector" → enable
- [ ] Copy `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
- [ ] Copy `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- [ ] Copy `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`
- [ ] Run migrations: `pnpm supabase db push`

### 2. Supabase Auth — Google OAuth
- [ ] Go to Supabase Dashboard → Authentication → Providers → Google → Enable
- [ ] Create a Google OAuth app at console.cloud.google.com
  - Authorized redirect URI: `https://<your-supabase-project>.supabase.co/auth/v1/callback`
- [ ] Paste Google Client ID + Secret into Supabase Google provider settings
- [ ] Add `http://localhost:3000` and your production URL to Supabase Auth → URL Configuration → Redirect URLs

### 3. Anthropic API Key
- [ ] Go to console.anthropic.com → API Keys → Create key
- [ ] Copy → `ANTHROPIC_API_KEY`
- [ ] Ensure your account has access to `claude-sonnet-4-5`

### 4. Spotify Developer App
- [ ] Go to developer.spotify.com → Dashboard → Create App
- [ ] App name: `Splice` | Description: moment-first music discovery
- [ ] Select "Web API" as the API being used
- [ ] Add redirect URIs: `http://localhost:3000/api/auth/spotify/callback` and your production URL
- [ ] Copy Client ID → `SPOTIFY_CLIENT_ID`
- [ ] Copy Client Secret → `SPOTIFY_CLIENT_SECRET`
- [ ] Manually add up to 25 test user emails: Dashboard → your app → Settings → User Management
  ⚠️ Do NOT attempt to apply for extended quota mode. Development mode is sufficient.

### 5. Inngest
- [ ] Create account at inngest.com
- [ ] Create a new app
- [ ] Copy Event Key → `INNGEST_EVENT_KEY`
- [ ] Copy Signing Key → `INNGEST_SIGNING_KEY`
- [ ] In production: add the Inngest webhook URL to your Vercel deployment

### 6. Railway (Analysis Service)
- [ ] Create account at railway.app
- [ ] Create a new project → Deploy from GitHub → select `splice` repo → set root to `services/analysis`
- [ ] Set environment variables in Railway dashboard:
  - `ANALYSIS_SERVICE_SECRET` (generate a random 32-char string, match in web app)
  - `PORT=8000`
- [ ] Copy the generated Railway URL → `ANALYSIS_SERVICE_URL` in web app env

### 7. AcousticBrainz Data Import (one-time)
- [ ] Download the low-level CSV dump from: https://acousticbrainz.org/download
  - File: `acousticbrainz-lowlevel-features.csv.bz2` (~2GB compressed)
- [ ] Run the import script (see `services/analysis/README.md`):
  ```bash
  python import_acousticbrainz.py --input acousticbrainz-lowlevel-features.csv \
    --supabase-url $NEXT_PUBLIC_SUPABASE_URL \
    --supabase-key $SUPABASE_SERVICE_ROLE_KEY \
    --limit 500000
  ```
- [ ] Import takes ~30-60 min. Monitor via the Supabase table editor.
- [ ] After import, run: `SELECT count(*) FROM track_features;` — should be ~500K rows

### 8. Vercel Deployment
- [ ] Connect repo to Vercel at vercel.com
- [ ] Set root directory to `apps/web`
- [ ] Add all env vars from `apps/web/.env.local` to Vercel project settings
- [ ] Add production domain → update Supabase Auth redirect URLs
- [ ] Add `NEXT_PUBLIC_APP_URL` to your production domain

### 9. Generate `ANALYSIS_SERVICE_SECRET`
```bash
# Run this locally, use the output in both services
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Coding Conventions

- Use TypeScript strictly — no `any`, prefer `unknown` with type narrowing
- All Supabase queries go through the typed client generated by `supabase gen types`
- All Claude API calls go through `lib/anthropic.ts` — never call the SDK directly from components or route handlers
- Zod schemas for all external data (Claude responses, Spotify API responses, analysis service responses)
- Error boundaries on all async UI — never let a failed API call produce an unhandled error
- Route handlers use `NextResponse.json()` consistently with typed response shapes
- The waveform scrubber is the signature UI — treat it as a first-class citizen, not an afterthought

---

## Phase Plan

### Phase 1 — Core Loop (MVP)
- [ ] Auth (Google OAuth via Supabase)
- [ ] Track search (Spotify metadata)
- [ ] Waveform scrubber + timestamp selection
- [ ] Natural language moment description input
- [ ] Claude moment interpretation → `MomentDescriptor`
- [ ] On-demand audio analysis (30s preview → librosa → pgvector)
- [ ] pgvector similarity search → match results
- [ ] Moment result cards with timestamp + explanation

### Phase 2 — Intelligence Layer
- [ ] Saved moments library (per user)
- [ ] Moment-based playlist export to Spotify
- [ ] Match feedback (thumbs up/down) → descriptor refinement
- [ ] Pre-indexed AcousticBrainz corpus searchable without on-demand analysis
- [ ] Shareable moment cards (OG image generation)

### Phase 3 — Social / Network Effects
- [ ] Public moment collections
- [ ] "X people saved this moment" social proof
- [ ] Moment discovery feed (trending moments)

---

## Known Constraints & Decisions

| Decision | Rationale |
|---|---|
| No Spotify audio analysis | Deprecated Nov 2024, restricted to 250K MAU orgs May 2025 |
| 30s preview only for analysis | Spotify preview URLs are public, no auth required |
| AcousticBrainz for catalog | 29M pre-computed feature tracks, free, CC0, still downloadable |
| Railway for analysis service | Docker-native, simple deploy, Python support, cheap for low traffic |
| Inngest for job queue | Already familiar from Meridian, handles retry logic cleanly |
| 128-dim embedding | Balance between matching precision and pgvector index performance |
| No mobile app (Phase 1) | Web-first for portfolio demo; Expo possible in Phase 3 |
