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
| AI/LLM | Anthropic Claude API | `claude-sonnet-4-5` for moment interpretation + match explanation |
| Moment Embeddings | LAION-CLAP (music checkpoint) | 512-dim joint audio/text space; **this is what search compares** |
| Audio Analysis | Python (librosa + essentia) | Display metadata only (key/BPM/chords) — never searched |
| Waveform UI | WaveSurfer.js | Scrubber + region selection |
| Music Metadata | Spotify Web API | Track search + metadata only (no audio analysis) |
| Music Catalog | Self-analyzed via `seed-catalog.ts` | Every row built by our own pipeline, one embedding space |
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
-- track_features: per-track DISPLAY metadata (key, BPM, sections, chords)
-- moment_embeddings: per-window CLAP vectors — the searchable index
-- moment_matches: cached match results (TTL-based invalidation)
```

See `supabase/migrations/0001_initial_schema.sql` for the base schema and
`20260804010000_moment_embeddings.sql` for the moment-level search index.

### Moment Embedding Schema

**Search operates on windows, not tracks.** `moment_embeddings` holds one row per
~10s of audio (10s window, 5s hop), each with a 512-dim L2-normalized CLAP vector:

```sql
moment_embeddings(spotify_id, start_s, end_s, embedding vector(512), embedding_model)
```

Because each row carries its own timespan, **a search hit is a timestamp** — the
moment shown on a result card is the moment that actually matched.

Two rules that are not optional:

1. **Never mix embedding spaces.** Vectors from different models are not
   comparable by cosine similarity, and mixing them silently produces
   confident-looking nonsense rather than an error. Every query filters on
   `embedding_model`; `storeAnalysis()` refuses to write a mismatched vector.
2. **`track_features.embedding` is vestigial.** It held the old hand-built
   128-dim vector. Nothing reads it. Do not reintroduce track-level matching —
   it makes moment search impossible by construction and forces the API to
   invent timestamps.

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

If a track has no rows in `moment_embeddings` for the current model:
1. Inngest job fires: `analysis/track.requested`
2. Analysis service resolves audio (Spotify preview → Apple Music preview via ISRC)
3. CLAP embeds each 10s window → the searchable vectors
4. librosa + essentia extract key/BPM/time signature/chords → display metadata only
5. `storeAnalysis()` writes both, refusing any embedding-space mismatch
6. Frontend polls until analysis completes, then proceeds to matching

**Full-track path:** the user can supply their own audio file
(`POST /api/analyze/upload`). Previews are only 30s, so a moment marked at 3:40
could never correspond to analyzed audio — an upload removes that mismatch.
Uploaded bytes are analyzed in memory and never persisted.

### Flow 4: Matching

1. `POST /api/match` builds a query vector:
   - **audio** — `source_moment_embedding()` mean-pools the source track's own
     windows across the selected span, in the database
   - **text** — CLAP's text tower embeds the user's description into the *same*
     space, so a typed moment queries the catalog directly with no LLM in the
     retrieval path
   - both present → weighted blend (`AUDIO_QUERY_WEIGHT`)
2. `match_moments()` runs HNSW cosine search over `moment_embeddings`,
   over-fetching then `DISTINCT ON (spotify_id)` so one track can't flood results
3. Below `MATCH_MIN_SIMILARITY`, results are dropped — an honest empty state
   beats a fabricated near-miss
4. Claude writes a one-line explanation per match, **given the measured features**
   (timestamp, BPM, key, chord) and instructed not to invent what it can't see
5. Each card shows track info, the real matched timestamp, and inline playback
   seeked to that moment

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

## Catalog Strategy

> ⚠️ **AcousticBrainz is retired as a data source. Do not reintroduce it.**

The project originally imported ~500K AcousticBrainz rows. Two fatal problems:

1. Its low-level data is **track-level aggregates only** — the import fabricated a
   single full-track "segment". Moment matching against it is impossible by
   construction.
2. Its embedding layout was **structurally different** from the one our own
   pipeline produces. The two were never comparable by cosine similarity, so
   every AcousticBrainz-sourced result was noise dressed up with a percentage.

The catalog is now built exclusively by `apps/web/scripts/seed-catalog.ts`, which
runs a genre/era-diverse seed list through the *same* `/analyze` endpoint that
serves live user searches. One embedding space, genuine per-window features,
from the first row on.

Coverage is bounded by preview availability, so the seed prefers **Apple Music
previews via ISRC** (near-total catalog coverage) over Spotify's, which are now
absent for most apps.

---

## Analysis Service (Python)

FastAPI microservice. Deployed on Railway (Docker).

**Endpoints:**
- `POST /analyze` — audio URL → windowed CLAP embeddings + display metadata
- `POST /analyze-upload` — same, from a multipart file (full-length tracks)
- `POST /embed-text` — description → 512-dim vector in the shared audio/text space
- `GET /health` — health check, reports `embedding_model` and load state

**Key libraries:**
- `laion-clap` — the moment embeddings (this is the search signal)
- `torch` (CPU-only wheels) — CLAP inference
- `librosa` — structural segmentation, chroma, MFCCs, beat tracking
- `essentia` — tonal analysis, danceability, dynamic complexity
- `fastapi`, `uvicorn` — API server
- `httpx` — async audio file fetching

> ⚠️ **Run ONE uvicorn worker.** The CLAP checkpoint is ~2GB resident and each
> worker is a separate process with its own copy — the previous `--workers 16`
> would have needed ~32GB of RAM. Concurrency comes from `ANALYSIS_CONCURRENCY`
> (a semaphore over a threadpool) inside the single process, which is the right
> shape anyway since analysis is CPU-bound.

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

### 7. Catalog Seed (one-time, run deliberately — it costs Railway compute)

> Do NOT run this before the CLAP analysis service is deployed and `/health`
> reports the expected `embedding_model`. Seeding against the wrong service
> fills the catalog with vectors from a space nothing else can query.

- [ ] Confirm the service is up: `curl $ANALYSIS_SERVICE_URL/health`
- [ ] Dry run first — resolves candidates, writes nothing, calls no `/analyze`:
  ```bash
  pnpm --filter web seed:catalog -- --dry-run --limit 200
  ```
- [ ] Real run (start small, then widen):
  ```bash
  pnpm --filter web seed:catalog -- --limit 2000 --concurrency 4
  ```
- [ ] Verify one embedding space and real coverage:
  ```sql
  SELECT embedding_model, count(*) AS windows, count(DISTINCT spotify_id) AS tracks
  FROM moment_embeddings GROUP BY 1;
  ```
- [ ] Only after results look sane, purge the legacy rows:
  `DELETE FROM track_features WHERE source = 'acousticbrainz';`
- [ ] Retune `MATCH_MIN_SIMILARITY` against the real score distribution

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
- [x] Auth (Google OAuth via Supabase)
- [x] Track search (Spotify metadata)
- [x] Waveform scrubber + timestamp selection (includes window/range selection, not just a single point)
- [x] Natural language moment description input
- [x] Claude moment interpretation → `MomentDescriptor`
- [x] On-demand audio analysis (30s preview → librosa → pgvector), incl. chord/key/time-signature detection beyond original scope
- [x] pgvector similarity search → match results, incl. moment-window (not just full-track) embedding and Deep Cut mode
- [x] Moment result cards with timestamp + explanation

### Phase 1.5 — Search Rebuild (code complete, NOT yet validated against a deploy)
- [x] CLAP (512-dim, joint audio/text) replaces the hand-built 128-dim embedding
- [x] `moment_embeddings` — per-window vectors; a search hit is a real timestamp
- [x] Removed the synthetic descriptor-derived query vector that made every
      search run on a meaningless input
- [x] Full-track upload path, so marks outside the 30s preview mean something
- [x] Auth UI + moment saving (both previously unreachable)
- [x] Inline result playback seeked to the matched moment
- [ ] **Deploy the CLAP analysis service** — nothing below can be validated first
- [ ] **Purge AcousticBrainz rows + re-seed** via `seed-catalog.ts` (the cutover)
- [ ] **Retune `MATCH_MIN_SIMILARITY` and the `matchStrength()` bands** against a
      real seeded catalog — current values are provisional guesses

### Phase 2 — Intelligence Layer
- [x] Saved moments library (per user)
- [ ] Moment-based playlist export to Spotify
- [ ] Match feedback (thumbs up/down) → descriptor refinement — `moment_feedback` table exists in schema, no API/UI wired up
- [ ] Shareable moment cards (OG image generation)
- [x] Apple Music integration (genre enrichment, ISRC resolution, preview-URL fallback, deep links) — not originally scoped, shipped alongside Phase 1

### Phase 3 — Social / Network Effects
- [ ] Public moment collections
- [ ] "X people saved this moment" social proof
- [ ] Moment discovery feed (trending moments)

---

## Known Constraints & Decisions

| Decision | Rationale |
|---|---|
| No Spotify audio analysis | Deprecated Nov 2024, restricted to 250K MAU orgs May 2025 |
| Apple Music previews preferred | Spotify no longer returns `preview_url` for this app; Apple covers ~the whole catalog via ISRC |
| CLAP over MERT | MERT has stronger music representations, but CLAP's **text tower** lets a typed description query the catalog directly — that removes the LLM from the retrieval path entirely |
| Window-level, not track-level | Track-level averages make moment search impossible by construction and force fabricated timestamps |
| 10s window / 5s hop | CLAP's encoder natively consumes ~10s; 50% overlap keeps boundary-straddling moments near a window centre |
| User-supplied full tracks | The only legally clean route to full-length audio; bytes are analyzed in memory and never stored |
| Catalog built by our own pipeline | Guarantees one embedding space — the failure mode that made AcousticBrainz useless |
| Railway for analysis service | Docker-native, simple deploy, Python support, cheap for low traffic |
| Inngest for job queue | Already familiar from Meridian, handles retry logic cleanly |
| No mobile app (Phase 1) | Web-first for portfolio demo; Expo possible in Phase 3 |
