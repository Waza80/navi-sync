-- Add the force_tag_repair setting.
--
-- The library repair normally skips any file that already carries a title and
-- artist, which keeps routine scans cheap. That skip is wrong for exactly the
-- files that need help: metaflac once transcoded tags to the process charset
-- (LC_CTYPE=C in a slim image with no locales), turning every non-ASCII byte
-- into '#'. Those files still have a title and artist — just mangled ones — so
-- the repair reported success while rewriting nothing, and the album stayed
-- split across three Navidrome entries no matter how often the index was
-- repaired.
--
-- Setting this true makes the repair rewrite embedded tags on every filed file,
-- from canonical database values, with --no-utf8-convert. It is the manual
-- escape hatch for re-tagging a whole library after a tagging bug is fixed.
--
-- Default false preserves the cheap behaviour.

ALTER TABLE settings ADD COLUMN IF NOT EXISTS force_tag_repair boolean NOT NULL DEFAULT false;
