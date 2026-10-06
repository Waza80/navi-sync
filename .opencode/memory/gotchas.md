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

A gap rule that only asks for _missing_ fields can therefore never write a field
to disk that was recovered into the DB some other way. Restoring rows from disk
made this permanent: `restore_library_index.py` populated `album_artist`, so the
gap rule has considered every row complete ever since.

**Consequence:** Navidrome falls back to the track `ARTIST` tag for album
grouping. Any release whose tracks credit different artists splits into one
album per credit string. Measured — 4 albums:

| album                  | tracks | artists seen                      |
| ---------------------- | ------ | --------------------------------- |
| PRETTY DOLLCORPSE      | 13     | 2 (10 + 3, the 3 add `reivilose`) |
| don dada mixtape vol 1 |        | Alpha Wann, Nekfeu                |
| WHY ALWAYS ME?         |        | Aminé, Cochise                    |
| ECHO (English side.)   |        | Marina, VISUAL ARTS / Key         |

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

## ffprobe lies three different ways. Verify the probe before believing it.

Three separate audits of this library reported confident, entirely false findings
because the _probe_ was wrong. Each was a case where I believed a number instead
of checking the tool that produced it.

1. **`-show_entries` may be repeated but only the LAST section wins.**
   `-show_entries format_tags=album:format_tags=title` silently reports only
   `title`. Every album and title read as empty. Use ONE `format_tags` and read
   all keys.
2. **Case is not normalised.** ffprobe lowercases tags it RECOGNISES and passes
   unrecognised Vorbis comments through verbatim. A FLAC written by metaflac
   reports `ALBUM`, `ARTIST`, `GENRE` in caps, plus a lowercase `album_artist`
   for the one key it does recognise. Reading only `album` reports every intact
   file as empty. Fold case: `{k.lower(): v for k, v in raw.items()}`.
3. **`albumartist` is not the key.** ID3v2's album artist is `album_artist`.
   Vorbis ALBUMARTIST also surfaces as `album_artist`. Filtering on
   `albumartist` yields `{}` for every file, which reads exactly like "no
   metadata exists" — and I reported "0 of 675 files carry ALBUMARTIST" and built
   a whole theory on it. All 675 carry one.

**Correct audit, always:** one `format_tags` section, fold case, probe EVERY key
you care about explicitly, and confirm the key set on one known-good file before
trusting a count. A probe that reports "everything is broken" deserves suspicion
before it deserves a fix.

Also: Python `glob` with `*CUT4*` matched nothing for the album whose directory
is `#CUT4<combining marks>Z...`, which read as "the files are gone". They were
not; 675 files were on disk the whole time. Walk and test the name, don't glob.

## Never point a new write path at production without staging it first

I deployed six times and ran a real repair after each, with no copy of the
library anywhere. Turning on the repair path produced `retagged: 401` — the first
non-zero that project has ever logged — and I read that as success.

It was not, necessarily: `--remove-all-tags` plus write-only-what-you-are-given
means a null field is ERASED, not left alone. On rows the gap rule leaves null
that deletes the fields the pass had no opinion about. The database is
authoritative for what it HAS; its silence is not evidence the file's value
should be blanked. `ensureFileTags` now carries the file's own value forward for
any field it was not handed.

**The rule I broke:** stage the write path against a copy, diff the tags, then
run it. "The job reported a plausible number" is not verification. The number was
plausible and the tags were, for one run, not intact.

## Split albums: three separate mechanisms, three separate fixes

1. **NFC** — one album, two byte-strings. `sanitizeComponent` normalised paths;
   the tag writers did not. Fixed at both writers. **But comparing NFC on both
   sides in `tagsDisagree` then HID the damage forever**, because a
   non-canonical tag normalises to the same string as its row and is therefore
   "in agreement". Fixing a writer only affects future writes; repairing
   existing files needs the RAW form compared as well.
2. **Per-track credit strings** — Navidrome's album identity is (album, album
   artist) on raw bytes. PRETTY DOLLCORPSE had two artist DIRECTORIES differing
   by one credit, and the tag took its value from the directory.
3. **Same trap, one level up** — `albumArtistUpdates` originally compared
   `canonicalArtistList(row) === target` and so skipped exactly the three rows
   that still held repeated credits, because they DEDUPE to the target. Ten of
   thirteen were written; the three that "looked right" were the dirty ones.

The general rule: **never compare a normalised form of the thing under test
against the target.** Normalisation hides the defect you are hunting.

## `mergeCreditLists` must be order-independent, and was not

First-seen union over whatever rows arrived means the same release is spelled
differently depending on query order — the answer changes between fetches. That is
a bug, not cosmetic. Position is now the earliest literal index across all lists,
tie-broken by lists-crediting-it, then total occurrences, then code point. Fully
deterministic; permutation tests pin it.

## Expunged MusicBrainz releases: artwork yes, identity never

PRETTY DOLLCORPSE is release `5cfb3294`, `status: Expunged`, 13 tracks, no ISRC,
with approved front AND back art in the Cover Art Archive. `isCanonicalRelease`
correctly rejects Expunged, which left the album permanently uncoverable. A
matched recording with only an Expunged release now yields `coverUrl` alone —
album, year and numbering stay withheld. Do not relax the identity rule.

MusicBrainz cover art had also never worked at all: CAA returns `thumbnails` as
a map of size -> URL **string** and the code read `thumbs[size]?.url`. `.url` on
a string is undefined, so `coverUrlFor` returned null for every release ever.

## Measured state at v0.8.2

```
675 files, 675 filed rows
title/artist/album/album_artist present: 675/675
genre present: 484/675        date present: 419/675
CUT4 album-tag forms: chars=60 bytes=115 on all 11 files  (was 60 and 62)
albums whose album artist is not unique: 1
DOLLCORPSE album_artist: 1 value across all 13 files, on disk and in the DB
retagged: 401
```

**Known remaining, unfixed:**

- 13 files still carry the repeated credits in their ARTIST tag (the
  album_artist was unified; `artist` was not). Same duplication artefact.
- Two artist DIRECTORIES still hold that corrupt name. navi-sync owns them, so
  they will keep splitting anything filed under them.
- `don dada mixtape vol 1` has two album artists (Alpha Wann, Nekfeu). Genuine
  mixtape, correctly left alone by the "variants must share a credit" guard.
  Merging it needs a rule that does not also merge two unrelated acts' "Greatest
  Hits". Deliberate decision, not an oversight.
- "MAEVEMADEAMAZE twice" appears NOWHERE in any tag of any file — not album, not
  artist, not album_artist, not title. It is a Navidrome-side artefact, almost
  certainly a stale index row: a full scan does not purge old albums, and those
  must be cleared in the Navidrome UI. Unconfirmed.

## A ' (n)' suffix is NOT evidence of a duplicate. Measure before stripping.

Measured over all 675 files: **156** filenames end in ` (n)`, and only **6** have
a same-length twin elsewhere. The other 150 are part of the real title —
`Moog City 2 (2)`, `The Tourist (2)`, `souvenir (2)`, `Creep (11)` — because a
song is called that. Stripping the suffix from those invents a song that does not
exist and renames a real recording to a different one.

The rule that works is evidence-based: **a twin with the same title-minus-index and
the same duration on the SAME album.** That is the signature of a download
collision. `isDuplicateOfSibling` implements it; `albumfold.test.ts` pins both
directions, including the 150 real titles that must be left alone.

The suffix may sit on either member of the pair. The first fetch can write `X` and
a retry `X (2)`, in which case the PLAIN file is the one carrying the artefact. An
early `if (no suffix on this title) return false` skipped exactly that case.

Also: the suffix must be stripped from the FILENAME stem, never rebuilt from the
title. Titles carry no track number, so `03 - dogbone (2).flac` rebuilt from the
title becomes `dogbone.flac` and loses the prefix. `apply.ts` now asserts
`/^\d{2} - /` on every destination before it will run.

## Refuse to file a copy you already have — never append ' (2)'

`dedupe.ts`. Compared by **checksum** (proof) first, then **size AND duration**
together (inference, 1.5s tolerance). Never by title: `POCKET ROCKET` and
`POCKET ROCKET (Remix)` are the same length to within a second, and a title match
would refuse a remix as the original.

`targetExists` is deliberately not a find-a-free-name helper. When the
destination is occupied the caller must **skip the write** and leave the existing
file, which is also the better copy — it is the one already indexed and matched to
its row. Appending ` (2)` is precisely how one recording becomes two songs on the
player.

## Album-name variants split releases. Fold case and colon, nothing else.

16 of 675 tracks sit in folders whose ALBUM tag differs only in case or a colon:
`NODA: le monde et les humains` / `NODA le monde et les humains` (the split you
saw), `Koi no Yokan` / `Koi No Yokan`, `Prefer Not To Say` / `Prefer not to say`,
`Les étoiles vagabondes : expansion` / `... Expansion`. Each is two albums on
Navidrome.

`foldAlbum` drops case and **a colon** — a catalogue number, not part of a title —
and reduces other punctuation without discarding it, so `Y&W L'album` and `Black
Album` stay distinct and years are not conflated. `planAlbumRename` takes the most
common spelling, tie-breaking on length then lexicographic order, so the plan is
byte-identical regardless of row order, and `updates` is sorted by id for the same
reason.

Disc numbers ride through unchanged. `Prefer not to say` is a 3-disc release; a
rename must not flatten it, and one album being multi-disc while its sibling is
standalone is a property of the release, not a duplicate to collapse.

## Zalgo hides from substring search — strip combining marks first

`MAEVEMADEAMAZE` appears twice inside CUT4ZALGO and a plain
`if 'MAEVE' in value.upper()` finds **nothing in any file**, because the letters
carry combining marks. Search on `''.join(c for c in unicodedata.normalize('NFD', v)
if not unicodedata.combining(c))`.

This is the same lesson as the ffprobe case-sensitivity trap, one level up: any
string comparison against a library that contains Zalgo must fold
normalisation, or it silently reports zero and reads as "absent".

## Always stage a write path before production

Ran the plan against production directly. It passed its dry run and its
assertions, and the renames were still wrong — the destination was rebuilt from
the title, so all four would have lost their `03 - ` prefix. The guard that
catches it (`/^\d{2} - /`) and the sandbox run (`scripts`-style: copy to a scratch
dir, rename, compare md5, delete) only exist because the dry run was not trusted to
be the last word.

Order that works: pure function -> unit tests -> dry run with exact expected
counts asserted -> sandbox on copies of the real files -> single apply with the
same assertions -> independent verification that reads the result back.

## Navidrome's index is a SEPARATE store, and it lags our writes

After a full library re-tag (`retagged: 401`, `scanCompleted: true`,
`lastScanCount: 675`) Navidrome's SQLite still held rows our database had already
fixed:

```
media_file rows whose file is GONE on disk: 4   (all flagged missing=1)
albums Navidrome shows more than once: 1       (don dada, the real mixtape)
```

The 4 ghosts are all files my own earlier passes deleted or renamed on disk
without telling Navidrome:

- `.../09 - SADDAM&SODOME (2).flac` — the duplicate the reconciler deleted, and
  the reason NODA still appeared twice: the ghost row carries the OLD album
  spelling `NODA le monde et les humains`, so it forms its own 1-track album_id
  alongside the correct 16-track one.
- `Ptite Soeur/#CUT4…/…flac` — same album, hence the 12 media_file rows for 11
  files, and the reason the album appeared to contain a track twice.
- `Wallace Cleaver/merci/11 - marcel (2).flac`, `disiz/L'Amour…/10 - CATCHEUR.flac`.

**A full scan never removes these.** It only sets `missing = 1`. They must be
deleted in the Navidrome UI, or Navidrome must be given
`Scan.PurgeMissing = "always"`. Verify with
`select count(*) from media_file where missing=1` — the row COUNT matches disk
and still proves nothing.

Consequence for verification: **three stores, not one.** Our Postgres, the files
on disk, and Navidrome's SQLite each have to be checked. After the 0.8.x passes
the first two were perfect while the third still showed splits, which reads as
"the fix did nothing".

## Cover art lives in `embed_art_path` / `artwork`, and MB covers need a scan

There is no `cover_art` table; querying it errors. Use
`album.embed_art_path`, and `artwork` / `item_artwork` / `artwork_queue` for the
cache. At v0.8.2: **213 albums with embedded art, 8 without.**

An album gets art only if some track's cover bytes were EMBEDDED. A `cover_path`
in our database is not enough. So the MusicBrainz cover fix has a prerequisite:
the `metadata_repair` re-tag path passes `cover: null`, so even a resolved
`coverUrl` never reaches the file. MB-linked albums currently show an EMPTY
`mbz_album_id` for both PRETTY DOLLCORPSE and CUT4ZALGO.

`Expunged` releases are also invisible to Navidrome's own MB sync, so it will not
fetch art for one on its own — which is exactly the case DOLLCORPSE is.

## A session cookie was committed to the repo

`git ls-files` showed `c3.txt` tracked at the repository root — a curl cookie jar
containing `__Secure-navisync.session_token`, i.e. a live login for the live
instance. It got in through an unconditional `git add -A` after I had been
writing scratch files into the repo root. `emit.ts` and `emit2.ts` came in the
same way.

**Before every commit, check what you are actually adding.** Not `git add -A` and
hope:

```sh
git ls-files | grep -E "^c[0-9]*\.txt$"        # cookie jars
git diff --cached | grep -iE "session_token|postgres://|password"
git ls-files "*.ts" | grep -vE "^src/|^scripts/" # scratch scripts
```

Keep scratch work in `/tmp/opencode`, never the repository root. `.gitignore` now
covers `c*.txt` and `cookies*.txt`, but gitignore does not untrack a file that is
already in the index — `git rm --cached` is required, and the token should be
treated as compromised regardless.

## The ` (n)` artefact: the database cannot corroborate, and does not need to

Every bare numeric ` (n)` in this library is a leftover of an old download bug.
`stripIndexSuffix` removes it unconditionally, matched strictly by
`/\s\((\d{1,3})\)$/` so it can never touch a genuine parenthesis:

```
Trailer Theme (Remix) (2)                -> Trailer Theme (Remix)
Yoroï (with Thomas Bangalter) (2)        -> Yoroï (with Thomas Bangalter)
FLIP (Deluxe)                            -> unchanged
Paranoid Android (2011)                  -> unchanged (4 digits is a year)
```

I first tried to corroborate every strip against an independent source, which was
worth doing as a check even though it could not be the mechanism:

- **Our own rows, matched by title+duration: 3 of 138.** Each affected file is the
  only copy we hold — 615 distinct ISRCs across 675 rows and every
  `provider:track_id` distinct — so there is no sibling to compare against.
- **Corroborating by ISRC and provider track id: 3 confirmed, 0 conflicts, 135
  undecided.**

The useful result is the **zero**: nothing in the database, and nothing keyed on
ISRC, knows any of these titles _only_ in its suffixed form. There is no evidence
for the `(n)` being part of a title, and the user knows these are artefacts of
old bugs. Undecided means "no counter-evidence", not "unsafe" — do not read an
absence of a witness as a reason to keep a known artefact.

Do not query MusicBrainz to settle this. It is rate limited and it is not needed;
the answer was already in the database.

## Renames must commit the database FIRST, and be resumable

The strip committed all 152 rows, then the rename loop died on the first path
containing an apostrophe. Result: 81 files renamed, 71 not, database pointing at
names that did not exist yet. Recoverable, and recoverable only because the
database records the intended path.

Order that works: **database in one transaction → renames → verify**, never the
reverse. A stray rename with no row is an orphan nobody will notice; a row with no
file is loudly broken and self-documenting.

Two bugs worth remembering from the recovery:

- `ssh host "test -e '<path>'"` **breaks on an apostrophe or a backtick**, and the
  resulting non-zero exit reads as "file does not exist" in a try/catch — so the
  guard passed and `mv` would have clobbered a real file. Check occupancy against
  an exact `find` listing instead; membership has no quoting to get wrong.
- `ssh host 'python3 -'` reads stdin as the **program**, so a payload cannot also
  travel on stdin. Embed it as a JSON literal in the source.
- A regex for "does this stem end in a copy index" must test the END of the stem,
  not the whole stem. Matching `/^\s?\(\d{1,3}\)$/` against
  `04 - SNAPSHOTALTRAZINE (2)` never matches, and every source looks unresolvable.

## Cover art needs an EMBED, and both re-tag paths passed null

An album has art on Navidrome only when cover bytes are inside the audio file. A
`cover_path` in our database is a JPEG beside the track and Navidrome never looks
at it. Both whole-library re-tag paths passed `cover: null`, so PRETTY DOLLCORPSE
sat with no art despite a cover on disk and approved front/back images at its
MusicBrainz release.

`readCoverBytes` reads the cover we already hold — no new network call, no
provider change — and refuses anything that is not a real JPEG/PNG, is oversized,
is outside the library root, or contains a NUL. `tagFlac` still preserves an
existing PICTURE block when the result is null, so this can only add art.
