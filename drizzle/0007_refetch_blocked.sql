-- Add refetch_blocked.
--
-- A track that cannot be fetched (region-locked, delisted, never released) was
-- re-attempted by the retry sweep every cycle, forever. The user can now mark a
-- failed row as a dead end, which stops both the automatic sweep and the manual
-- "Retry all failed" from touching it.
--
-- Default false so nothing changes until the user asks for it.

ALTER TABLE tracks ADD COLUMN IF NOT EXISTS refetch_blocked boolean NOT NULL DEFAULT false;

-- Never retry a row the user has already given up on.
CREATE INDEX IF NOT EXISTS tracks_retry_idx
  ON tracks (download_status, refetch_blocked, updated_at);