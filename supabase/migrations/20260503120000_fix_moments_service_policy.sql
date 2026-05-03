-- ============================================================
-- Splice — 20260503120000_fix_moments_service_policy.sql
--
-- The moments table was missing a service_role RLS policy,
-- unlike every other table the service role writes to
-- (tracks, track_features, moment_matches, analysis_jobs).
--
-- Without this, the service role client in /api/interpret
-- cannot INSERT into moments (or SELECT back the inserted id),
-- causing the "Failed to save moment" error on the UI.
-- ============================================================

create policy "moments_service_all"
  on public.moments for all to service_role
  using (true)
  with check (true);
