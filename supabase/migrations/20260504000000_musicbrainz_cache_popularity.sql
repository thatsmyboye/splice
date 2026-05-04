-- ============================================================
-- Splice — 20260504000000_musicbrainz_cache_popularity.sql
--
-- Adds a Spotify popularity score to musicbrainz_cache so that
-- AcousticBrainz-sourced tracks can be filtered correctly by
-- Deep Cut mode. Resolved via ISRC → Spotify search on first
-- encounter; NULL means the track could not be found on Spotify
-- (i.e. genuinely obscure), not "unknown".
-- ============================================================

ALTER TABLE public.musicbrainz_cache
  ADD COLUMN IF NOT EXISTS popularity integer;
