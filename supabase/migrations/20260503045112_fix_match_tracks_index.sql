-- ============================================================
-- Splice — 0007_fix_match_tracks_index.sql
--
-- Rewrites match_tracks to use the HNSW index.
--
-- The v2 implementation buried the <=> operator inside a CTE
-- with no ORDER BY / LIMIT on the inner scan, forcing a full
-- sequential scan over all 500K embeddings (~12s).  pgvector
-- can only use the HNSW index when the query reads:
--
--   ORDER BY embedding <=> query_embedding
--   LIMIT n
--
-- at the innermost point of contact with track_features.
--
-- Fix: fetch candidates via the HNSW index first, then apply
-- the COF key boost to the small result set.
-- ============================================================

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
  -- Use ORDER BY <=> LIMIT so the planner uses the HNSW index.
  -- Over-fetch by 5x when key boosting is on so reranking has headroom
  -- (the boost is small so top candidates stay close to the final order).
  candidates AS (
    SELECT
      tf.spotify_id,
      1 - (tf.embedding <=> query_embedding)  AS raw_similarity,
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
    ORDER BY tf.embedding <=> query_embedding
    LIMIT CASE WHEN key_boost_weight > 0 THEN match_count * 5 ELSE match_count END
  )
  SELECT
    c.spotify_id,
    CASE
      WHEN key_boost_weight > 0
        AND source_key_name IS NOT NULL
        AND c.key_name IS NOT NULL
      THEN
        c.raw_similarity + key_boost_weight *
          GREATEST(0.0,
            1.0 - (
              ABS(
                COALESCE((SELECT pos FROM cof_positions WHERE key = source_key_name), 0) -
                COALESCE((SELECT pos FROM cof_positions WHERE key = c.key_name), 0)
              )::float / 6.0
            )
          )
          * CASE WHEN c.key_mode = source_key_mode THEN 1.0 ELSE 0.7 END
      ELSE c.raw_similarity
    END AS similarity,
    c.bpm,
    c.key_name,
    c.key_mode,
    c.time_signature,
    c.harmonic_rhythm,
    c.key_confidence,
    c.analysis_version,
    c.segments
  FROM candidates c
  ORDER BY similarity DESC
  LIMIT match_count;
$$;
