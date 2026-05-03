-- ============================================================
-- Splice — 0006_harmonic_features.sql
--
-- Adds harmonic analysis columns to track_features:
--   time_signature, key_confidence, harmonic_rhythm
--
-- Updates match_tracks RPC to v2 with optional
-- circle-of-fifths key compatibility boosting.
--
-- All changes are additive — no existing data is touched.
-- Old v1.0 rows have NULL for the three new columns.
-- ============================================================

-- New scalar columns (nullable so v1.0 rows are unaffected)
ALTER TABLE public.track_features
  ADD COLUMN IF NOT EXISTS time_signature  SMALLINT,
  ADD COLUMN IF NOT EXISTS key_confidence  FLOAT,
  ADD COLUMN IF NOT EXISTS harmonic_rhythm FLOAT;

-- New rows default to v2.0 analysis version
ALTER TABLE public.track_features
  ALTER COLUMN analysis_version SET DEFAULT '2.0';

-- The segments JSONB column already exists. No structural change needed:
-- chord_label and chord_confidence are absent on v1.0 rows and
-- present on v2.0 rows. TypeScript types them as optional.

-- ============================================================
-- Replace match_tracks RPC with v2
-- New optional params add COF key boosting (default: off)
-- Passing key_boost_weight=0.0 reproduces exact v1 behavior.
-- ============================================================
DROP FUNCTION IF EXISTS public.match_tracks(vector(128), int, text);

CREATE OR REPLACE FUNCTION public.match_tracks(
  query_embedding        vector(128),
  match_count            int     DEFAULT 20,
  exclude_spotify_id     text    DEFAULT NULL,
  source_key_name        text    DEFAULT NULL,
  source_key_mode        text    DEFAULT NULL,
  key_boost_weight       float   DEFAULT 0.0
)
RETURNS TABLE (
  spotify_id         text,
  similarity         float,
  bpm                float,
  key_name           text,
  key_mode           text,
  time_signature     smallint,
  harmonic_rhythm    float,
  key_confidence     float,
  analysis_version   text,
  segments           jsonb
)
LANGUAGE sql STABLE
AS $$
  WITH cof_positions(key, pos) AS (
    VALUES
      ('C',0),('G',1),('D',2),('A',3),('E',4),('B',5),
      ('F#',6),('Gb',6),('C#',7),('Db',7),('Ab',8),('Eb',9),('Bb',10),('F',11)
  ),
  base AS (
    SELECT
      tf.spotify_id,
      1 - (tf.embedding <=> query_embedding)   AS raw_similarity,
      tf.bpm,
      tf.key_name,
      tf.key_mode,
      tf.time_signature,
      tf.harmonic_rhythm,
      tf.key_confidence,
      tf.analysis_version,
      tf.segments
    FROM public.track_features tf
    WHERE
      tf.embedding IS NOT NULL
      AND (exclude_spotify_id IS NULL OR tf.spotify_id != exclude_spotify_id)
  )
  SELECT
    b.spotify_id,
    CASE
      WHEN key_boost_weight > 0
        AND source_key_name IS NOT NULL
        AND b.key_name IS NOT NULL
      THEN
        b.raw_similarity + key_boost_weight *
          GREATEST(0.0,
            1.0 - (
              ABS(
                COALESCE((SELECT pos FROM cof_positions WHERE key = source_key_name), 0) -
                COALESCE((SELECT pos FROM cof_positions WHERE key = b.key_name), 0)
              )::float / 6.0
            )
          )
          * CASE WHEN b.key_mode = source_key_mode THEN 1.0 ELSE 0.7 END
      ELSE b.raw_similarity
    END AS similarity,
    b.bpm,
    b.key_name,
    b.key_mode,
    b.time_signature,
    b.harmonic_rhythm,
    b.key_confidence,
    b.analysis_version,
    b.segments
  FROM base b
  ORDER BY similarity DESC
  LIMIT match_count;
$$;
