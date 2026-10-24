-- One file, one row.
--
-- Two rows pointing at the same path is how a duplicate download turns into a
-- broken library entry: DELETE /api/tracks/:id removes the file for the row it
-- deletes, and the surviving row — which still claims that path — is left
-- pointing at nothing until it is fetched again. The application now refuses to
-- create the second row and the delete route checks for co-owners, but a
-- constraint is what makes the invariant true under concurrency: two download
-- jobs can both look before either writes.
--
-- Partial on purpose: file_path is NULL for every failed/pending row, and those
-- must not collide with each other.
--
-- Guarded rather than silently destructive. If duplicates exist the migration
-- stops with the count, so the operator runs scripts/reconcile-library.ts (which
-- adopts and verifies BEFORE deleting anything) instead of this file guessing
-- which of two rows owns the audio.

DO $$
DECLARE
  dup_count integer;
  sample text;
BEGIN
  SELECT count(*), string_agg(file_path, E'\n' ORDER BY file_path)
    INTO dup_count, sample
    FROM (
      SELECT file_path
      FROM tracks
      WHERE file_path IS NOT NULL
      GROUP BY file_path
      HAVING count(*) > 1
      LIMIT 20
    ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'refusing to create tracks_file_path_uq: % duplicate file_path group(s) exist. Run scripts/reconcile-library.ts first. Examples: %',
      dup_count, sample;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tracks_file_path_uq
  ON tracks (file_path)
  WHERE file_path IS NOT NULL;
