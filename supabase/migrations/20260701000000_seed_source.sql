-- ============================================================
-- Splice — 20260701000000_seed_source.sql
--
-- Adds 'seed' as an allowed track_features.source value, distinct
-- from 'on_demand'. Both are produced by the identical analysis
-- pipeline (real segment-level librosa/essentia features, same
-- embedding layout) -- the only difference is provenance: 'seed'
-- rows come from the deliberate bulk-seed script
-- (apps/web/scripts/seed-catalog.ts), 'on_demand' rows come from
-- organic user searches. Kept separate purely for visibility into
-- how the catalog grew, e.g.:
--
--   SELECT source, count(*) FROM track_features GROUP BY source;
-- ============================================================

ALTER TABLE public.track_features
  DROP CONSTRAINT track_features_source_check;

ALTER TABLE public.track_features
  ADD CONSTRAINT track_features_source_check
  CHECK (source in ('acousticbrainz', 'on_demand', 'synthetic', 'seed'));
