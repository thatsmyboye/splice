-- ============================================================
-- Splice — 0003_moment_matches_unique.sql
--
-- Adds UNIQUE constraint on moment_matches.moment_id so that
-- the upsert in /api/match (onConflict: "moment_id") works
-- correctly for result caching.
-- ============================================================

alter table public.moment_matches
  add constraint moment_matches_moment_id_key unique (moment_id);
