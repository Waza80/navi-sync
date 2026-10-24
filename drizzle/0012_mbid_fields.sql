-- MusicBrainz identities, stored rather than re-derived.
--
-- The library already kept `artist_mbid` because names are not identities, but
-- the recording/release identities were never persisted. They cannot be
-- recovered later: a recording that gets merged or redirected in MusicBrainz
-- answers a title search with a DIFFERENT id, so "ask again tomorrow" is not a
-- fallback — it is a different answer. Navidrome, Picard, ListenBrainz and every
-- scrobbler key on these ids, so they belong in the row and in the file tags.
--
-- `release_track_mbid` is the position-specific id (MUSICBRAINZ_RELEASETRACKID),
-- distinct from the recording id (MUSICBRAINZ_TRACKID): a DJ player needs the
-- release track to jump to the right spot on a specific edition.

ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "recording_mbid" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "release_mbid" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "release_group_mbid" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "album_artist_mbid" text;
ALTER TABLE "tracks" ADD COLUMN IF NOT EXISTS "release_track_mbid" text;

-- Automatic post-download scans can be turned off. A 400-track playlist drains
-- over hours, and each debounce window fired another scan job that held a worker
-- slot and issued an HTTP scan; users who would rather scan on their own
-- schedule need a switch, not a code change.
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "auto_scan" boolean NOT NULL DEFAULT true;
