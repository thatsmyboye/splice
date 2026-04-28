-- ============================================================
-- Splice — 0002_musicbrainz_cache.sql
--
-- Caches MusicBrainz recording metadata (title + artist) for
-- AcousticBrainz-indexed tracks that appear in match results.
-- These tracks have spotify_id = "ab:{mbid}" in track_features
-- but no corresponding entry in the tracks table.
-- ============================================================

create table public.musicbrainz_cache (
  mbid       text primary key,
  title      text not null,
  artist     text not null,
  cached_at  timestamptz default now()
);

alter table public.musicbrainz_cache enable row level security;

create policy "musicbrainz_cache_read_all"
  on public.musicbrainz_cache for select to anon, authenticated
  using (true);

create policy "musicbrainz_cache_service_write"
  on public.musicbrainz_cache for all to service_role
  using (true);
