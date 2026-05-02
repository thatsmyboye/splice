-- Allow synthetic embeddings generated from Claude MomentDescriptor values.
-- These are stored when no Spotify preview URL is available for audio analysis,
-- giving the catalog immediate entries to match against.
alter table public.track_features
  drop constraint track_features_source_check;

alter table public.track_features
  add constraint track_features_source_check
  check (source in ('acousticbrainz', 'on_demand', 'synthetic'));
