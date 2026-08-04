-- ============================================================
-- Splice — 20260804020000_upload_source.sql
--
-- Adds 'upload' as a track_features.source value.
--
-- Provenance matters here more than for the other sources. 'seed' and
-- 'on_demand' rows are derived from a 30s preview, so their windows only ever
-- cover the opening fragment of a track. 'upload' rows are derived from a
-- full-length file the user supplied, so their windows span the whole
-- recording and a mark at 3:40 refers to real analyzed audio.
--
-- Being able to tell them apart lets the UI say which one it's working from,
-- and lets a preview-derived row be superseded later by a full-track one.
-- ============================================================

ALTER TABLE public.track_features
  DROP CONSTRAINT track_features_source_check;

ALTER TABLE public.track_features
  ADD CONSTRAINT track_features_source_check
  CHECK (source in ('acousticbrainz', 'on_demand', 'seed', 'upload'));

-- How much of the track the stored windows actually cover. NULL for rows
-- predating this column. The UI reads it to tell the user whether marking a
-- moment late in a song is meaningful or out of analyzed range.
ALTER TABLE public.track_features
  ADD COLUMN IF NOT EXISTS analyzed_duration_s real;

COMMENT ON COLUMN public.track_features.analyzed_duration_s IS
  'Seconds of audio actually analyzed. ~30 for preview-derived rows, full length for uploads.';
