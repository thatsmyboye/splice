-- Add Spotify popularity score (0–100) to the tracks table.
-- Used by the Deep Cut feature to filter out mainstream tracks.
-- NULL means popularity hasn't been fetched yet (older rows, AB tracks).
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS popularity integer;
