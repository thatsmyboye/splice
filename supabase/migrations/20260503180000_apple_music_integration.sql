-- ============================================================
-- Splice — Apple Music Integration
--
-- Adds Apple Music catalog identity fields to tracks and
-- musicbrainz_cache so result cards can surface Apple Music
-- deep links and genre enrichment data.
-- ============================================================

-- tracks: cache ISRC (from Spotify external_ids) and the
-- resolved Apple Music catalog ID for that recording.
ALTER TABLE public.tracks
  ADD COLUMN IF NOT EXISTS isrc           text,
  ADD COLUMN IF NOT EXISTS apple_music_id text;

CREATE INDEX IF NOT EXISTS idx_tracks_isrc
  ON public.tracks(isrc) WHERE isrc IS NOT NULL;

-- musicbrainz_cache: store ISRC (from MusicBrainz inc=isrcs)
-- and resolved Apple Music ID for AcousticBrainz-sourced tracks.
ALTER TABLE public.musicbrainz_cache
  ADD COLUMN IF NOT EXISTS isrc           text,
  ADD COLUMN IF NOT EXISTS apple_music_id text;
