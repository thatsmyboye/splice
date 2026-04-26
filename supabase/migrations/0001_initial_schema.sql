-- ============================================================
-- Splice — 0001_initial_schema.sql
-- Run via: pnpm supabase db push
--
-- Prerequisites (manual):
--   1. Enable pgvector extension in Supabase Dashboard first:
--      Dashboard → Database → Extensions → "vector" → Enable
--   2. Supabase project must exist with service role key set
-- ============================================================

-- Enable pgvector (idempotent after manual dashboard enable)
create extension if not exists vector with schema extensions;

-- ============================================================
-- TRACKS
-- Cached Spotify track metadata. Source of truth for track IDs.
-- spotify_id is the primary external identifier.
-- mbid links to MusicBrainz (used to join AcousticBrainz data).
-- ============================================================
create table public.tracks (
  id           uuid primary key default gen_random_uuid(),
  spotify_id   text unique not null,
  mbid         text,                         -- MusicBrainz Recording ID (nullable — not all tracks have one)
  title        text not null,
  artist       text not null,
  album        text,
  duration_ms  integer,
  preview_url  text,                         -- Spotify 30s preview MP3 URL
  artwork_url  text,
  genres       text[],                       -- from MusicBrainz tags (populated async)
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index idx_tracks_spotify_id on public.tracks(spotify_id);
create index idx_tracks_mbid on public.tracks(mbid) where mbid is not null;

-- ============================================================
-- TRACK_FEATURES
-- Segment-level audio feature vectors for similarity search.
-- One row per track. The embedding is a 128-dim normalized
-- vector derived from librosa + essentia analysis of the
-- Spotify 30s preview (or AcousticBrainz pre-computed data).
-- ============================================================
create table public.track_features (
  id              uuid primary key default gen_random_uuid(),
  track_id        uuid references public.tracks(id) on delete cascade,
  spotify_id      text unique not null,                -- denormalized for fast lookup
  mbid            text,
  source          text not null default 'on_demand'    -- 'acousticbrainz' | 'on_demand'
    check (source in ('acousticbrainz', 'on_demand')),
  analysis_version text not null default '1.0',

  -- Segment-level data (JSONB array of section descriptors)
  -- Each item: { start_s, duration_s, energy, spectral_centroid,
  --              chroma_vector[12], mfcc_means[13], loudness_db }
  segments        jsonb,

  -- Track-level aggregates (from essentia)
  bpm             float,
  key_name        text,                               -- e.g. 'C', 'F#'
  key_mode        text,                               -- 'major' | 'minor'
  danceability    float,                              -- 0.0–1.0
  dynamic_complexity float,

  -- Primary matching vector: 128-dim embedding of normalized features
  -- Used for pgvector cosine similarity search (<=> operator)
  embedding       vector(128),

  analyzed_at     timestamptz default now(),
  created_at      timestamptz default now()
);

create index idx_track_features_spotify_id on public.track_features(spotify_id);
create index idx_track_features_source on public.track_features(source);

-- HNSW index for pgvector cosine similarity search.
-- Preferred over IVFFlat: no training step, works on empty tables,
-- and has better speed-recall tradeoff for typical query volumes.
-- If corpus grows past 1M rows, tune m and ef_construction upward.
create index idx_track_features_embedding
  on public.track_features
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ============================================================
-- MOMENTS
-- User-defined moment annotations.
-- A moment is a specific point or range in a specific track
-- that the user has flagged as meaningful.
-- ============================================================
create table public.moments (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references auth.users(id) on delete cascade,
  track_id            uuid references public.tracks(id) on delete cascade,

  -- The moment itself
  timestamp_start_s   float,                          -- nullable if description-only
  timestamp_end_s     float,
  user_description    text,                           -- free-text from the user

  -- Claude-interpreted descriptor (stored as JSONB)
  -- Shape: MomentDescriptor (see packages/types/index.ts)
  moment_descriptor   jsonb,

  -- Embedding derived from moment_descriptor (for future moment-to-moment matching)
  descriptor_embedding vector(64),

  is_public           boolean default false,
  is_saved            boolean default true,           -- false = transient (not yet saved)
  title               text,                           -- optional user-given name

  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create index idx_moments_user_id on public.moments(user_id);
create index idx_moments_track_id on public.moments(track_id);
create index idx_moments_public on public.moments(is_public) where is_public = true;

-- HNSW index for future moment-to-moment similarity search (Phase 2).
-- Only indexes rows where the embedding has been computed.
create index idx_moments_descriptor_embedding
  on public.moments
  using hnsw (descriptor_embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where descriptor_embedding is not null;

-- ============================================================
-- MOMENT_MATCHES
-- Cached match results for a given moment.
-- Invalidated when the source moment changes or after 7 days.
-- Prevents re-running expensive pgvector queries on repeat views.
-- ============================================================
create table public.moment_matches (
  id             uuid primary key default gen_random_uuid(),
  moment_id      uuid references public.moments(id) on delete cascade,

  -- Ordered array of match results (JSONB)
  -- Each item: { spotify_id, artist, title, timestamp_s,
  --              similarity_score, claude_explanation }
  results        jsonb not null default '[]',

  created_at     timestamptz default now(),
  expires_at     timestamptz default (now() + interval '7 days')
);

create index idx_moment_matches_moment_id on public.moment_matches(moment_id);
create index idx_moment_matches_expires on public.moment_matches(expires_at);

-- ============================================================
-- ANALYSIS_JOBS
-- Job tracking for async on-demand audio analysis.
-- Inngest fires the job; this table tracks status.
-- ============================================================
create table public.analysis_jobs (
  id             uuid primary key default gen_random_uuid(),
  spotify_id     text not null,
  status         text not null default 'pending'
    check (status in ('pending', 'processing', 'complete', 'failed')),
  error_message  text,
  inngest_run_id text,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

create index idx_analysis_jobs_spotify_id on public.analysis_jobs(spotify_id);
create index idx_analysis_jobs_status on public.analysis_jobs(status);

-- ============================================================
-- MOMENT_FEEDBACK
-- Thumbs up/down on individual match results.
-- Used in Phase 2 to refine moment descriptors.
-- ============================================================
create table public.moment_feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  moment_id   uuid references public.moments(id) on delete cascade,
  result_spotify_id text not null,               -- which match result was rated
  rating      smallint not null check (rating in (-1, 1)),  -- -1 = thumbs down, 1 = thumbs up
  created_at  timestamptz default now(),
  unique (user_id, moment_id, result_spotify_id)
);

create index idx_moment_feedback_moment_id on public.moment_feedback(moment_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.tracks          enable row level security;
alter table public.track_features  enable row level security;
alter table public.moments         enable row level security;
alter table public.moment_matches  enable row level security;
alter table public.analysis_jobs   enable row level security;
alter table public.moment_feedback enable row level security;

-- tracks: publicly readable, service role only for writes
create policy "tracks_read_all"
  on public.tracks for select to anon, authenticated
  using (true);

create policy "tracks_service_write"
  on public.tracks for all to service_role
  using (true);

-- track_features: publicly readable, service role only for writes
create policy "track_features_read_all"
  on public.track_features for select to anon, authenticated
  using (true);

create policy "track_features_service_write"
  on public.track_features for all to service_role
  using (true);

-- moments: users own their moments; public moments readable by all
create policy "moments_select_own_or_public"
  on public.moments for select to authenticated
  using (user_id = auth.uid() or is_public = true);

create policy "moments_select_public_anon"
  on public.moments for select to anon
  using (is_public = true);

create policy "moments_insert_own"
  on public.moments for insert to authenticated
  with check (user_id = auth.uid());

create policy "moments_update_own"
  on public.moments for update to authenticated
  using (user_id = auth.uid());

create policy "moments_delete_own"
  on public.moments for delete to authenticated
  using (user_id = auth.uid());

-- moment_matches: readable by authenticated users (results are not user-private)
create policy "moment_matches_read_authenticated"
  on public.moment_matches for select to authenticated
  using (true);

create policy "moment_matches_service_write"
  on public.moment_matches for all to service_role
  using (true);

-- analysis_jobs: service role only
create policy "analysis_jobs_service_all"
  on public.analysis_jobs for all to service_role
  using (true);

create policy "analysis_jobs_read_authenticated"
  on public.analysis_jobs for select to authenticated
  using (true);

-- moment_feedback: users own their feedback
create policy "moment_feedback_own"
  on public.moment_feedback for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

-- Auto-update updated_at timestamps
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger tracks_updated_at
  before update on public.tracks
  for each row execute procedure public.handle_updated_at();

create trigger moments_updated_at
  before update on public.moments
  for each row execute procedure public.handle_updated_at();

create trigger analysis_jobs_updated_at
  before update on public.analysis_jobs
  for each row execute procedure public.handle_updated_at();

-- ============================================================
-- VECTOR SIMILARITY SEARCH FUNCTION
-- Called from the web app's /api/match route handler.
-- Returns top N tracks by cosine similarity to the query vector,
-- excluding the source track.
-- ============================================================
create or replace function public.match_tracks(
  query_embedding  vector(128),
  match_count      int     default 20,
  exclude_spotify_id text  default null
)
returns table (
  spotify_id         text,
  similarity         float,
  bpm                float,
  key_name           text,
  key_mode           text,
  segments           jsonb
)
language sql stable
as $$
  select
    tf.spotify_id,
    1 - (tf.embedding <=> query_embedding) as similarity,
    tf.bpm,
    tf.key_name,
    tf.key_mode,
    tf.segments
  from public.track_features tf
  where
    tf.embedding is not null
    and (exclude_spotify_id is null or tf.spotify_id != exclude_spotify_id)
  order by tf.embedding <=> query_embedding
  limit match_count;
$$;

-- ============================================================
-- SEED: Analysis version marker
-- Used to invalidate cached features when analysis pipeline changes
-- ============================================================
comment on column public.track_features.analysis_version is
  'Increment when librosa/essentia pipeline changes to force re-analysis';
