-- Artist identity + reindex bookkeeping.
--
-- 1. artist_mbid: the MusicBrainz artist id. Deezer keeps a French rapper and a
--    US electronic producer on ONE artist page (110750, "Tanger", 67 albums), so
--    anything keying on the display name merges two people. MusicBrainz separates
--    them: 9ba3809e… ("French band") and 7d90e27a… ("Electronic music producer").
--
-- 2. metadata_refreshed_at / metadata_status: a full re-fetch has to be able to
--    report what it did. Previously a repair pass was indistinguishable from a
--    no-op, and because enrichment only asked for MISSING fields, a filled-but-
--    wrong value (releaseYear 2013 for a 1998 album) could never be corrected.

ALTER TABLE tracks ADD COLUMN IF NOT EXISTS artist_mbid text;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS metadata_refreshed_at timestamp;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS metadata_status text;

-- The reindex sweep selects filed rows in id order and skips ones refreshed
-- recently, so this partial index carries the whole pass.
CREATE INDEX IF NOT EXISTS tracks_reindex_idx
  ON tracks (metadata_refreshed_at)
  WHERE file_path IS NOT NULL;
