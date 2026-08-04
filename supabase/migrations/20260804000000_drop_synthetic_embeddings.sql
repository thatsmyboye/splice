-- ============================================================
-- Splice — 20260804000000_drop_synthetic_embeddings.sql
--
-- Retires the 'synthetic' track_features source.
--
-- Background: /api/interpret used to insert a placeholder row whose
-- embedding was the Claude MomentDescriptor's 6 scores tiled 21x to
-- fill 128 dims, so a track would be "searchable" before the analysis
-- service had run (0004_synthetic_source.sql).
--
-- That vector shares no space with the real librosa/essentia
-- embeddings, but /api/match selected the source track's features
-- without excluding it — so it became the *query vector* for every
-- search. Measured against the catalog, it produced cosine
-- similarities in a 0.41–0.68 band with 99.97% of rows clearing the
-- 0.5 "genuine match" threshold: the ranking was arbitrary and the
-- similarity percentages shown to users were noise.
--
-- The write path is removed in this same change. This migration:
--   1. Deletes the leftover placeholder rows (no real analysis is
--      lost — these rows never contained audio-derived features).
--   2. Drops 'synthetic' from the allowed source values so the
--      pattern cannot come back by accident.
-- ============================================================

DELETE FROM public.track_features WHERE source = 'synthetic';

ALTER TABLE public.track_features
  DROP CONSTRAINT track_features_source_check;

ALTER TABLE public.track_features
  ADD CONSTRAINT track_features_source_check
  CHECK (source in ('acousticbrainz', 'on_demand', 'seed'));
