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
--
-- Idempotent: safe to run even if the policy already exists.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'moments'
      AND policyname = 'moments_service_all'
  ) THEN
    EXECUTE 'CREATE POLICY "moments_service_all"
      ON public.moments FOR ALL TO service_role
      USING (true)
      WITH CHECK (true)';
  END IF;
END
$$;
