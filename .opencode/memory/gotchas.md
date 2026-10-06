# Gotchas

Each of these has cost a session. They are not stylistic preferences.

## Postgres `SUBSTRING` with a capture group

```sql
-- WRONG: no capture group, so Postgres returns the WHOLE match
substring(x from '^.*/music/')
-- RIGHT
substring(x from '^.*/music/(.*)$')
```

Hit twice. Silent, and it looks like a path bug.

## Unlayered CSS beats `@layer utilities`

`@layer utilities` has the lowest priority of all, so a plain
`.m3-icon-button { background-color: transparent }` outside any layer overrides
`bg-primary` no matter the specificity. Component classes must live in
`@layer components`. This is why the play button was invisible.

## `node-id3` dereferences _present_ keys

Passing `synchronisedLyrics: undefined` made node-id3 dereference an upstream typo
(`'lycics.language'`) and throw, which killed the entire tag write — untagged MP3s.
Filter undefined keys out before calling it. Same class of bug: any key present
in the object gets used, however meaningless its value.

## Prettier / svelte plugin mismatch

`bun run format` fails on 9 `.svelte` files with `getVisitorKeys is not a function`
(prettier 3.9.9 vs plugin 3.5.2). Pre-existing on clean HEAD. Verify with
`git stash` before blaming your change.

## Svelte `$state` is not narrowed by `{#if}`

Re-reading `nullableState` inside a handler inside the block re-widens it to
`null`. Hoist with `{@const link = pastedLink}`. And a handler that mutates state
Svelte still has to flush must `await tick()` first — `queueMicrotask` runs before
the `{#if}` block exists.

## Pasting a link is not a search query

`/api/search` must classify a pasted URL _before_ searching. Forwarding a Deezer
artist link to every provider's text search is why it appeared to be unparseable.

## Making `parseRef` succeed is not the same as routing correctly

Adding album/artist recognition made artist links resolve — and a Deezer artist id
is shaped exactly like a song id, so the pipeline then called `song.getData` with
it and reported a gateway fault. When loosening a parser, check that every caller
downstream can tell the kinds apart.

## Album-wide failure means rights, not flakiness

Every track on an album failing together is a provider rights/tier block. Scattered
failures within one album are something else. Check `readable: true` in the public
API before concluding the track is gone.

## An id is not a fact

Verifying that `parseRef` returned an id is not verifying the download works. Check
the stage that actually fails, end to end, and predict the outcome before shipping
so the prediction can be falsified.

## ext4 limits and UTF-8

Zalgo and CJK must be preserved, but paths must still respect the 255-byte limit —
measure bytes, not characters. UTF-8 corruption came from writing with a lossy
encoding, not from the text itself.

## navi-sync deployment

A webhook deploys `main`. Do not deploy through the Coolify API.

## A batch endpoint you cannot safely loop is a trap

The reindex sweep enqueues one batch per POST. I called it in a loop twice and
both times it ran away — 4000 jobs, then 8000 jobs, for a 686-track library.

Two independent causes, and the second is the one to remember:

1. `freshnessHours: 0` means "no freshness filter", which removed the last guard.
   The endpoint behaved as documented; the caller did not.
2. `tracksWithPendingJob` deduped on `jobs.track_id`, but `enqueueJob` was never
   passed a `trackId`, so every job landed with NULL and the guard matched
   nothing. Only **171 of 686** tracks were ever refreshed while the queue burned
   through 8000 duplicates.

`refreshed` sat pinned at 171 for 30 straight minutes. I watched each round
report "enqueued 100" and read that as progress. It was not — the assertion that
catches this is that `refreshed` must ADVANCE, and a loop that watches its own
progress metric should abort when it does not.

Rules that follow: any bulk endpoint needs a real idempotency key, the caller
must assert forward progress, and a dedupe guard that depends on a column has to
be verified against the data actually being written — not against intent.

## Declared is not produced

A field can live in the type union, be requested by `neededFieldsFor`, appear in
every log line, and still never be written by anybody. `genre` was exactly that:
`MetadataField` listed it, the resolver asked for it, `cleanPatch` passed it
through, and **no source implemented it** — Tidal documents that it never sets
genre, the Deezer track payload has no genre field, MusicBrainz's genre list is not
in the recording payload we fetch, iTunes does not expose it here. So every row had
`genre: null` and the pipeline looked healthy.

Same shape as `artistMbid`, which was declared, produced by MusicBrainz, and then
silently dropped by a hand-written cleaner. Twice now.

When a column is suspiciously empty across the whole table, check whether anything
_writes_ it before checking whether anything is _reading_ it wrong.

## Deleting a row orphans its jobs

`DELETE /api/tracks/[id]` left the row's queued jobs running, so they dead-lettered
with "Track not found: <uuid>" — 25 of them, all noise created by the delete
itself. `cancelJobsForTrack` now cancels outstanding work for a row before the row
goes. The cancel must happen FIRST: a running job can otherwise write a file back
for a row that no longer exists.

## Bulk deletes need a row-count assertion

The library index was destroyed by `delete ... where file_path is not null` run
against an existence probe whose output I never checked. The probe returned
nothing, everything looked orphaned, and 686 rows went. The file-level guard
("never delete the only copy of a recording") existed; there was no row-level
equivalent.

Rules that follow, applied to every bulk write since:

- assert the probe returned what you expected BEFORE acting on it
- wrap the write in a transaction and ROLLBACK on any count mismatch
- rehearse with a rollback-only mode against the real schema first
- know the exact expected count and abort if it differs

## Whitelists are the recurring failure

Three separate fields were declared, sent or produced, and then dropped by a
hand-written list:

- `artistMbid` — in `MetadataPatch`, returned by MusicBrainz, dropped by `cleanPatch`.
- `genre` — in `MetadataField`, requested by `neededFieldsFor`, produced by NO source.
- `forceTagRepair` — in `AppSettings`, sent by the settings form, stripped by the
  settings PATCH schema because zod drops unknown keys.

Each looked healthy in the type system and in every log line. The durable fix is to
derive these schemas from the underlying types rather than re-declaring keys. That
has not been done and remains the most likely source of the next one.

## Verify the signal can change

Three deploy/observability mistakes in one session, all the same shape:

- `/api/health` returned a hardcoded `version: '0.1.0'`; I polled it for 14 minutes
  to detect a deploy and concluded "not deployed" on the strength of a constant.
- `/api/jobs` validated `limit` as `max(100)`, so `limit=300` FAILED validation and
  silently fell back to 30 — a request that looks honoured but is not.
- The job store was never subscribed: `live.start()` was called nowhere, so no SSE
  events arrived at all. Fixed three times in a row upstream (missing `$state`,
  non-`$state` field, never started).

Rule: before trusting a number, a status, or a version to mean something, confirm it
_can_ change. Then confirm the component actually receives it.

## The provider is often right and the pipeline wrong

Album-wide download failure (every track on an album) means a rights/tier block, not
a flaky request — Deezer lists the track `readable: true` and refuses the stream.
Scattered failure within one album is something else.

Reaching metadata is not reaching audio. The rescued-when-`NO_STREAM` path was the
fix for 30 Tanger tracks that metadata had already "found".

## Do not re-declare keys in a hand-written whitelist

(see above — this is the same item, kept here because it is the highest-value rule)

## Navidrome retains missing files — a full scan does NOT purge them

Measured on Navidrome 1.16.1 after deleting 67 files directly from disk and
running three full scans:

```
media_file rows: 723 | flagged missing: 67   (missing = 1, still listed)
after manual deletion in the Navidrome UI:
media_file rows: 656 | flagged missing: 0
```

`fullScan=true` re-walks the tree and updates what it finds. It does **not**
remove rows whose file is gone — it sets `media_file.missing = 1` and keeps them,
which is exactly what renders them greyed out. Six minutes of polling changed
nothing; the UI deletion did it in one action.

Consequences:

- `navidrome_scan` is not a cleanup mechanism. It repairs tags and metadata; it
  does not reconcile the index against the disk.
- A repair that reports `unindexedFiles: 0` and `missingFilesMarked: 0` has only
  proven the **navi-sync** side is clean. Navidrome's own index can still hold
  hundreds of rows for files deleted behind its back, and there is no app-side
  API to remove them.
- **Deleting files outside Navidrome will always leave ghosts.** After any bulk
  disk operation — dedupe, reconcile, a manual `rm` — someone has to clear
  Navidrome's UI, or Navidrome's `Scan.PurgeMissing` must be set to `always`.
  Treat that as a required step of the workflow, not a follow-up.

Verify with `select missing, count(*) from media_file group by 1`, not with the
row count. A matching row count proves nothing while stale rows exist and real
files are missing.

## Reindexing after a restore: rows outlive their checksums

`scripts/restore_library_index.py` rebuilds one row per file, but rows created
_before_ the restore survive alongside them. Result: several rows pointing at the
same `file_path` while carrying **different `checksum_sha256` values** — only one
of them can be describing the file that is actually there.

55 such groups, 59 surplus rows. The resolution is not "trust the newest row":

- match `checksum_sha256` against a freshly generated disk manifest, and
- prefer the row that also has genre / isrc / year / lyrics.

43 of 55 groups had a keeper whose checksum already matched disk; for the other
12 the keeper's checksum had to be **rewritten** to the disk value, because the
richest row was describing a copy that no longer exists. Deleting the wrong row
silently loses the only good metadata.

The bug that hid this: a loop with `if (rows.length === 1) continue` placed
_before_ the deleted-file check. Single-row paths were skipped, so 4 rows whose
file an earlier pass deleted without repointing were never seen. Put the
"does this file exist" check first, for every path.

Also: `track_id` and `id` are `uuid`, not `text`. `= any($1::text[])` fails with
`operator does not exist: uuid = text` **inside a transaction**, so every retry
after it reports `current transaction is aborted` and the real error scrolls away
in the noise. Read the first retry line, not the last.

## `forceTagRepair = true` would strip cover art from the whole library

Do not enable it as a "just re-tag everything" shortcut. `tagFlac` starts with
`metaflac --remove-all-tags` and re-imports a picture **only** if `tags.cover` is
a Buffer. Both whole-library re-tag call sites — the Navidrome repair loop in
`handlers.ts` and the adopt path in `db/tracks.ts` — pass `cover: null`, because
the cover lives in `cover_path` and is not read back. So a forced pass rewrites
every Vorbis comment and **deletes the embedded PICTURE block** on every FLAC.

That is almost certainly why the flag has stayed `false`: turning it on looks
correct and quietly destroys 675 covers.

The real fix is to make the re-tag cover-aware (read `cover_path`, or preserve
existing pictures with `--preserve-picture` semantics), not to flip the switch.

## 0 of 675 files carry ALBUMARTIST, so Navidrome groups albums by track ARTIST

Measured with `ffprobe -show_entries format_tags` over the whole library:

```
files carrying albumartist: 0 / 675
rows with album_artist in Postgres: 675 / 675
```

All three re-tag sites (`handlers.ts` download, Navidrome repair loop, adopt
path) pass `albumArtist` correctly, and both writers emit it (`performerInfo` /
TPE2 for ID3, `ALBUMARTIST` for Vorbis). The value is simply **null at write
time** — metadata is not resolved yet during a download — and nothing ever
re-writes it, because:

- the re-tag after a metadata pass only fires `if (Object.keys(patch).length > 0)`,
- `album_artist` is already filled in the DB, so `neededFieldsFor` never requests
  it, so `patch` stays empty and no re-tag happens; and
- the one unconditional re-tag loop is gated behind `forceTagRepair = false`.

A gap rule that only asks for *missing* fields can therefore never write a field
to disk that was recovered into the DB some other way. Restoring rows from disk
made this permanent: `restore_library_index.py` populated `album_artist`, so the
gap rule has considered every row complete ever since.

**Consequence:** Navidrome falls back to the track `ARTIST` tag for album
grouping. Any release whose tracks credit different artists splits into one
album per credit string. Measured — 4 albums:

| album | tracks | artists seen |
|---|---|---|
| PRETTY DOLLCORPSE | 13 | 2 (10 + 3, the 3 add `reivilose`) |
| don dada mixtape vol 1 | | Alpha Wann, Nekfeu |
| WHY ALWAYS ME? | | Aminé, Cochise |
| ECHO (English side.) | | Marina, VISUAL ARTS / Key |

4 is a floor, not a ceiling — every future collaborative release re-splits. The
fix is a disagreement-triggered re-tag (compare the file's tags to the DB row,
re-tag when they differ), not a one-off pass.

## Split-album triage: ask Navidrome, then read the tags off disk

Navidrome's Subsonic API is the fastest way to see a split: `getAlbumList2`
(type `alphabeticalByName`, not `A`) then `search3` for the name, then `getAlbum`
on the full id — **not an 8-char prefix**, which returns `Album not found` and
looks like a missing album. Two albums with the same name and year means the
grouping key differs; compare `artist`/`albumArtist` across the two.

On disk, read tags with `ffprobe`. Do **not** hand-roll a FLAC Vorbis-comment
parser to do it — one that assumes no block padding crashes with
`struct.error: unpack requires a buffer of 4 bytes` and, worse, silently returns
zero tags so every file looks untagged. That reads exactly like "no metadata
exists" and sends you fixing the wrong thing.

## Literal Zalgo strings in tests do not survive the shell

Writing the two combining-mark orderings literally into a heredoc got them
normalised before the assertion ran, so the test compared a string with itself
and passed for the wrong reason. Use explicit `\uXXXX` escapes. When a test
asserts "these two inputs differ", assert that FIRST — it is the assertion the
rest depends on, and it catches the mistake in the fixture itself.
