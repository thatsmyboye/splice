-- ============================================================
-- Splice — 0008_hnsw_index.sql
--
-- Replaces the IVFFlat embedding index on track_features with
-- HNSW, and adds the HNSW index on moments.descriptor_embedding.
--
-- Context: 0001 originally created an IVFFlat index. The
-- match_tracks rewrite in 20260503045112 was written expecting
-- HNSW (ORDER BY <=> LIMIT at the innermost scan), but the
-- index upgrade was never applied as a migration.
--
-- HNSW advantages over IVFFlat:
--   - No training step (works on empty tables)
--   - No need to pick a lists value relative to corpus size
--   - Better recall at comparable query latency
-- ============================================================

-- Replace IVFFlat with HNSW for the primary similarity search index.
DROP INDEX IF EXISTS public.idx_track_features_embedding;

CREATE INDEX idx_track_features_embedding
  ON public.track_features
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- HNSW index for moment-to-moment similarity search (Phase 2).
-- Partial index: only rows where descriptor_embedding has been computed.
CREATE INDEX idx_moments_descriptor_embedding
  ON public.moments
  USING hnsw (descriptor_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE descriptor_embedding IS NOT NULL;
