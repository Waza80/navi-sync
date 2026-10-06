# Recovery and reconciliation — the night of 2026-10-05/06

The single worst incident of the project, and the reasoning behind everything in
`src/lib/server/library/reconcile.ts`.

## What happened

A bulk delete ran against an **unverified existence probe**. The probe was a script
piped over `ssh` that returned nothing; I did not check that it returned anything;
every row therefore looked orphaned, and `delete from tracks where file_path is not
null` removed all **686** filed rows.

**The audio was never touched.** 715 FLAC/MP3 files remained on disk.

## What was lost, and what was not

Recoverable from disk: artist, album, track number, title, format, bit depth,
sample rate, duration, size, sha256, cover path, sidecar presence.

Not recoverable from disk: ISRC, release year, genre, album artist, provider link.
Those were re-fetched by the metadata reindex (MusicBrainz as ground truth).

## The two bugs that followed the restore, both mine

1. **Host paths written into the container's database.** The restore ran over ssh
   against `/mnt/hdd/music`, and stored the paths as it saw them. The app runs in a
   container where that volume is `/music`. 695 of 715 rows were wrong: covers failed
   to open and audio failed to stream. Fixed by rewriting the prefix inside a
   transaction with an expected-count assertion.
   **Rule: a restore must convert paths to what the CONSUMER reads, not what the
   restore tool saw.**

2. **Genre was never implemented by any source.** Every row had `genre: null` and the
   pipeline looked healthy. `genre` was in `MetadataField`, requested by
   `neededFieldsFor`, passed through by `cleanPatch` — and no source produced it.
   Deezer has it only on the album endpoint. Third time this shape appeared
   (`artistMbid`, `forceTagRepair`).

## Rules that now exist because of this

- A bulk write asserts the probe's output BEFORE acting on it.
- A bulk write runs in a transaction and rolls back on any count mismatch.
- Rehearse with a rollback-only mode against the real schema first.
- Know the exact expected count; abort if it differs.
- Never delete a file unless its survivor is indexed **or adopted in the same run**,
  and adoption happens and is verified **first**.
- A file must never be listed as both adopted and deleted. (This happened.)

## The reconciler

`src/lib/server/library/reconcile.ts` is **pure** — no filesystem, no database. All
decisions are made there and unit-tested; `scripts/reconcile-library.ts` is a thin
shell that gathers the inventory and applies the plan in two verified phases.

40 tests, including 6 property tests over generated libraries. Three real bugs were
found by those tests and would have been found on the real library otherwise:

- **The sort comparator was inverted.** A negative comparator result means "a first",
  so when B was the better file it had to return a positive value. Inverted meant the
  unprefixed file always won regardless of quality — a 24-bit fetch would be deleted
  in favour of the 16-bit original.
- **Titles were derived with `.flac` still attached**, so `Song.flac` and
  `Song (2).flac` were different identities, grouped separately, and the reconciler
  found nothing to do. A silent no-op that looks like "there are no duplicates".
- **`crossFolderMatching` included the directory in its key**, making it identical to
  the default. The flag appeared to work while doing nothing.

A property test I wrote was also wrong: it asserted "never delete an unsuffixed
file", but an unsuffixed original is legitimately deleted when a better suffixed
copy supersedes it. The test caught my own mis-specification.

## Grouping is delicate

Grouping by artist+title alone would delete
`Everybody Wants To Rule The World` from one of two albums where it legitimately
appears (`Classic 80's` and `Songs From The Big Chair`). Grouping by directory misses
the real orphans, which sit in a different folder from their sibling.

So a recording is artist+title+**directory**, with `crossFolderMatching` as an
explicit opt-in that drops the directory. A trailing `(n)` with no un-suffixed
partner anywhere is **never** deleted — `Menace (2)` may be a real title.

## Things that looked like bugs but were not

`find -regex ".* \([0-9]+\)\.[a-z]+"` matches `03 - 93.flac` and `06 - 200.flac`:
GNU `find` treats `\(` as a group, so it matched a space followed by a digit. Fifteen
files were flagged that way; all were real titles. The Python checker requires a
literal paren and reported zero duplicates.
