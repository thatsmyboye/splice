-- ============================================================
-- Splice — 20260804010000_moment_embeddings.sql
--
-- Introduces moment-level search.
--
-- Until now, track_features held ONE 128-dim vector per track. That made
-- genuine moment matching impossible by construction: the finest thing the
-- search could compare was a whole-track average, so /api/match had to invent
-- a timestamp for each result (it used the first segment's start_s — which is
-- why every result card claimed a "similar moment at 0:00").
--
-- This table stores one row per ~10s window of audio, each with its own CLAP
-- embedding. A search hit IS a timestamp, so the moment shown to the user is
-- the moment that actually matched.
--
-- track_features is kept for display metadata (key, BPM, chords, sections).
-- Its `embedding` column and the match_tracks RPC are now vestigial — the
-- follow-up cutover migration drops them once the catalog is re-seeded.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.moment_embeddings (
  id            bigserial PRIMARY KEY,
  spotify_id    text  NOT NULL,
  start_s       real  NOT NULL,
  end_s         real  NOT NULL,

  -- 512-dim CLAP vector, L2-normalized by the analysis service.
  embedding     vector(512) NOT NULL,

  -- Which embedding space this vector lives in. Vectors from different models
  -- are NOT comparable by cosine similarity; mixing two spaces silently is
  -- precisely the bug that made AcousticBrainz results meaningless. Every
  -- query filters on this.
  embedding_model text NOT NULL DEFAULT 'clap-music-audioset-v1',

  created_at    timestamptz DEFAULT now(),

  -- One row per (track, window start). Makes re-analysis idempotent.
  UNIQUE (spotify_id, start_s)
);

CREATE INDEX IF NOT EXISTS idx_moment_embeddings_spotify_id
  ON public.moment_embeddings(spotify_id);

-- HNSW rather than IVFFlat: no training step (works on an empty table, which
-- matters because the catalog is about to be rebuilt from zero) and better
-- recall at comparable latency.
SET statement_timeout = 0;
SET lock_timeout     = 0;

CREATE INDEX IF NOT EXISTS idx_moment_embeddings_embedding
  ON public.moment_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ============================================================
-- RLS — same posture as track_features: world-readable, service-role writes.
-- ============================================================

ALTER TABLE public.moment_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "moment_embeddings_read_all"
  ON public.moment_embeddings FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "moment_embeddings_service_write"
  ON public.moment_embeddings FOR ALL TO service_role
  USING (true);

-- ============================================================
-- match_moments
--
-- Returns the best-matching WINDOW per track, ranked by similarity.
--
-- Two details matter for correctness:
--
--   1. The inner scan must be a bare `ORDER BY embedding <=> q LIMIT n` for
--      pgvector to use the HNSW index. Any filtering or aggregation pushed
--      into that scan forces a sequential scan over the whole table.
--
--   2. A single track contributes many windows and a strong match usually
--      wins several adjacent ones. Without deduplication, one track would
--      fill the entire result page. So we over-fetch candidates, then take
--      DISTINCT ON (spotify_id) — the multiplier is what buys enough distinct
--      tracks to fill `match_count` after collapsing.
-- ============================================================

CREATE OR REPLACE FUNCTION public.match_moments(
  query_embedding       vector(512),
  match_count           int   DEFAULT 20,
  exclude_spotify_id    text  DEFAULT NULL,
  candidate_multiplier  int   DEFAULT 8,
  model_id              text  DEFAULT 'clap-music-audioset-v1'
)
RETURNS TABLE (
  spotify_id  text,
  start_s     real,
  end_s       real,
  similarity  float
)
LANGUAGE sql STABLE
AS $$
  WITH candidates AS (
    SELECT
      me.spotify_id,
      me.start_s,
      me.end_s,
      1 - (me.embedding <=> query_embedding) AS similarity
    FROM public.moment_embeddings me
    WHERE me.embedding_model = model_id
      AND (exclude_spotify_id IS NULL OR me.spotify_id <> exclude_spotify_id)
    ORDER BY me.embedding <=> query_embedding
    LIMIT GREATEST(match_count * candidate_multiplier, match_count)
  ),
  best_per_track AS (
    SELECT DISTINCT ON (c.spotify_id)
      c.spotify_id, c.start_s, c.end_s, c.similarity
    FROM candidates c
    ORDER BY c.spotify_id, c.similarity DESC
  )
  SELECT b.spotify_id, b.start_s, b.end_s, b.similarity
  FROM best_per_track b
  ORDER BY b.similarity DESC
  LIMIT match_count;
$$;

-- ============================================================
-- source_moment_embedding
--
-- Mean-pools the source track's windows overlapping [win_start, win_end) into
-- a single query vector. This replaces the analysis service's /embed-window
-- round-trip: the windows are already persisted, so the query vector can be
-- assembled in the database instead of re-fetching and re-embedding audio on
-- the user's critical path.
--
-- A null window selects the whole track (the description-only case).
-- ============================================================

CREATE OR REPLACE FUNCTION public.source_moment_embedding(
  source_spotify_id  text,
  win_start          real  DEFAULT NULL,
  win_end            real  DEFAULT NULL,
  model_id           text  DEFAULT 'clap-music-audioset-v1'
)
RETURNS vector(512)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  pooled  vector(512);
BEGIN
  SELECT AVG(me.embedding)::vector(512)
    INTO pooled
  FROM public.moment_embeddings me
  WHERE me.spotify_id = source_spotify_id
    AND me.embedding_model = model_id
    AND (
      win_start IS NULL
      OR (me.start_s < COALESCE(win_end, win_start + 0.001) AND me.end_s > win_start)
    );

  -- No window overlapped the selection (e.g. the mark sits past the end of the
  -- analyzed audio). Fall back to the nearest single window rather than
  -- returning NULL and failing the whole search.
  IF pooled IS NULL AND win_start IS NOT NULL THEN
    SELECT me.embedding
      INTO pooled
    FROM public.moment_embeddings me
    WHERE me.spotify_id = source_spotify_id
      AND me.embedding_model = model_id
    ORDER BY ABS(me.start_s - win_start)
    LIMIT 1;
  END IF;

  RETURN pooled;
END;
$$;
