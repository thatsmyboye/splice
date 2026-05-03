-- ============================================================
-- Splice — 0005_moment_matches_source_key.sql
--
-- The moment_matches cache key was only moment_id, which caused
-- results from a previously searched track to be returned for a
-- different source track that happened to share the same momentId.
--
-- Fix: add source_spotify_id column and replace the single-column
-- UNIQUE constraint with a composite (moment_id, source_spotify_id)
-- constraint so each (moment, source track) pair gets its own cache
-- entry.
-- ============================================================

alter table public.moment_matches
  add column source_spotify_id text not null default '';

alter table public.moment_matches
  drop constraint moment_matches_moment_id_key;

alter table public.moment_matches
  add constraint moment_matches_moment_source_key
  unique (moment_id, source_spotify_id);

create index idx_moment_matches_moment_source
  on public.moment_matches (moment_id, source_spotify_id);
