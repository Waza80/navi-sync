-- Normalize library paths stored in the tracks table.
--
-- `file_path` and `cover_path` are read straight off disk (`stat(coverPath)` in
-- the cover route), so they must be absolute inside the runtime container. Three
-- conventions had accumulated:
--
--   * `/music/Artist/Album/cover.jpg`   correct
--   * `Artist/Album/cover.jpg`          relative — resolved against the process
--                                       CWD, so it never existed
--   * `/home/wyzz/navi-sync/music/...`  a developer machine's path, which does
--                                       not exist inside the container
--
-- All three are collapsed onto the canonical `/music/...` form by keeping only
-- the part after the final `music/` segment. This is deliberately textual: no
-- filesystem access, so it is safe to run against a live database, and it is
-- idempotent (a second run is a no-op because `/music/...` re-normalizes to
-- `/music/...`).
--
-- Rows already correct are left untouched.
--
-- NOTE: `substring(x from pattern)` returns the WHOLE match unless the pattern
-- carries a capture group. With a bare `'^.*/music/'` every one of the 88 rows
-- became `/music//home/wyzz/navi-sync/music/` — strictly worse than before. The
-- `(.*)` group is what yields the part AFTER the marker.

-- 1. Paths carrying a foreign absolute host prefix.
UPDATE tracks
SET cover_path = '/music/' || substring(cover_path from '^.*/music/(.*)$')
WHERE cover_path IS NOT NULL
  AND cover_path <> ''
  AND cover_path LIKE '/home/%';

-- 2. Paths stored relative, with no root at all.
UPDATE tracks
SET cover_path = '/music/' || ltrim(cover_path, '/')
WHERE cover_path IS NOT NULL
  AND cover_path <> ''
  AND cover_path NOT LIKE '/%';

-- 3. Any remaining stray host prefix on file_path (none today, but the same
--    corruption mode applied to both columns).
UPDATE tracks
SET file_path = '/music/' || substring(file_path from '^.*/music/(.*)$')
WHERE file_path IS NOT NULL
  AND file_path LIKE '/home/%';
