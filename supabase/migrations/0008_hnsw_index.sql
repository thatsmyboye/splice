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
--
-- TIMEOUT NOTE:
--   HNSW index construction on the full AcousticBrainz corpus
--   (~500K rows) takes several minutes. The two SET statements
--   below disable statement_timeout and lock_timeout for this
--   session so the migration runner doesn't abort mid-build.
--   They do NOT affect other sessions or persist after the
--   connection closes.
--
-- MANUAL APPLICATION (SQL editor or psql):
--   The SQL editor has a hard HTTP timeout (~30s) that will
--   kill a long build even with SET statement_timeout = 0.
--   For large tables, apply outside the editor via psql:
--
--     psql "$DATABASE_URL" -f supabase/migrations/0008_hnsw_index.sql
--
--   Or use the CONCURRENTLY variant (no table lock, no timeout
--   risk, but must run outside an explicit transaction):
--
--     DROP INDEX IF EXISTS public.idx_track_features_embedding;
--     CREATE INDEX CONCURRENTLY idx_track_features_embedding
--       ON public.track_features
--       USING hnsw (embedding vector_cosine_ops)
--       WITH (m = 16, ef_construction = 64);
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_moments_descriptor_embedding
--       ON public.moments
--       USING hnsw (descriptor_embedding vector_cosine_ops)
--       WITH (m = 16, ef_construction = 64)
--       WHERE descriptor_embedding IS NOT NULL;
--
--   After running CONCURRENTLY manually, mark the migration
--   applied so supabase db push skips it:
--
--     INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
--     VALUES ('0008', '0008_hnsw_index', ARRAY['-- applied manually via CONCURRENTLY']);
-- ============================================================

-- Disable timeouts for this session. HNSW builds on large tables
-- can take several minutes; the defaults (8s–30s) are too short.
SET statement_timeout = 0;
SET lock_timeout     = 0;

-- Replace IVFFlat with HNSW for the primary similarity search index.
DROP INDEX IF EXISTS public.idx_track_features_embedding;

CREATE INDEX IF NOT EXISTS idx_track_features_embedding
  ON public.track_features
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- HNSW index for moment-to-moment similarity search (Phase 2).
-- Partial index: only rows where descriptor_embedding has been computed.
CREATE INDEX IF NOT EXISTS idx_moments_descriptor_embedding
  ON public.moments
  USING hnsw (descriptor_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE descriptor_embedding IS NOT NULL;
