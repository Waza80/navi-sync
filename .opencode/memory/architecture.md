# Architecture

## Providers

`src/lib/server/providers/` — registry order is precedence.

| Provider | Streams | Notes                                                                                                                                                                                                                                 |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tidal`  | Yes     | Self-hosted `hifi-api` instance. fMP4 demuxed to FLAC in pure TS (`tidal/mp4.ts`) — the production image has no ffmpeg. No artist-track or playlist endpoint (`/artist/albums/`, `/playlist/` → 404).                                 |
| `deezer` | Yes     | Needs a gateway (`DEEZER_RESOLVER_URL`) for album→track and artist album listings; the public API returns `InvalidQueryException` for song ids. Serves `FLAC_24` (24-bit/**96 kHz**) where a release has one; the id carries no rate. |

A `Provider` exposes: `parseRef`, `matches`, `metadata`, `search`, `resolve`,
optional `findByIsrc` / `findByIsrcInAlbum` / `albumTracks` / `albumTrackIds` /
`artistAlbumIds` / `playlistTrackIds` / `searchArtists`.

`TrackRef.kind` defaults to `'track'` but is load-bearing: a Deezer artist id is
shaped exactly like a song id, so without it the pipeline calls `song.getData`
with an artist id and reports a gateway fault instead of the real problem.
`runDownload` refuses any ref whose kind is not `'track'`; `matches()` still
accepts those URLs so `/api/search` can classify a pasted link and offer fan-out.

Metadata resolution (`src/lib/server/metadata/sources/musicbrainz.ts`) asks in
strict evidence order: stored `recordingMbid` → stored `releaseMbid` (its track
list names the position) → ISRC → strict title+artist(+duration) → **widened
fuzzy tokens with artist** → title-only → title+album → fuzzy tokens alone.
Two transport rules: every mirror/official hop goes through
`fetchWithBurstRetry` (one pause on 429/5xx — MB sheds bursts even at 1 req/s),
and mirror parking is status-shaped seconds (`cooldownMsForStatus`, never the
old 10-minute block). A proven identity on a non-Official release stores ids but
withholds album/year (`descriptiveWithheld`); title-only hits never yield
descriptive facts. `upgrade_check` reuses this path via stored ids first, and
quality ceiling/cooldown guards make a no-op `upgrade: false` the normal answer
for an already-lossless library.

## Queue

`src/lib/server/queue/` — `jobs.ts` (store), `worker.ts` (drain), `handlers.ts`
(job bodies), `relocate.ts` (re-finding a track elsewhere), `upgrades.ts`.

Download handler order: route → parse ref → metadata → enrich missing →
quality guardrail → resolve stream → download → verify integrity →
**measure, and refuse to replace a file that is not an improvement** → tag →
lyrics → file into library → embed lyrics → persist row.

Quality ranks 0–6 (`src/lib/shared/quality.ts`), with sample rate separating the
lossless tiers: 6 = 24/192 (ceiling), 5 = 24/96, 4 = 24/≤48k, 3 = 16-bit, 2 = MP3
320, 1 = lower MP3. Two rules matter more than the numbers:

- A descriptor with **no stated sample rate** ranks as hi-res. Providers
  advertise a 24-bit tier without saying what rate it is (Deezer's id is
  `FLAC_24`), so the optimistic reading is the only one that attempts the fetch.
- Nothing replaces a file on a claim. The downloaded audio is probed and compared
  with `measuredIsBetter` before it is tagged; a copy that is not strictly better
  is discarded and the row keeps what it had.

`preferHiRes` (settings) caps the fetch at 24/192 or 24/48 and is passed to
providers as part of `QualityPreferences`.

Two rescue paths exist, and they are different bugs:

- **Dead URL** → relocate by ISRC, then by strict name.
- **Refused stream** (`NO_STREAM`) → relocate on the _other_ enabled provider.
  Reaching metadata is not reaching audio: Deezer lists a track, returns full
  metadata, then refuses the stream. Only `NO_STREAM` qualifies — `PROVIDER_UNAVAILABLE`
  is the whole service down (retrying elsewhere proves nothing) and `NOT_FOUND`
  means there is nothing to fetch.

Relocation searches ISRC first (authoritative), then three separate query shapes:
`artist title`, title-only (requiring the artist), artist-only (requiring the
title). Tidal silently returns unrelated results for a combined query — measured:
`"Neverlose"` → 297 correct, `"Neverlose help_urself"` → 98 unrelated — so
relaxing the _query_ must never relax the _match_.

`runMetadataRepair` (the sweep body): pass 1 enriches with `{ force }` wired into
`neededFieldsFor` and passes stored MBIDs into the lookup; effective metadata is
`patch ?? row` everywhere downstream (cover path, relocate target, `ensureFileTags`)
— the old code used stale `row.artist`, so a corrected artist never reached the
folder. Retag+relocate opens on patch, embedded cover, **or misplacement itself**;
relocate carries `.lrc`, copies `cover.jpg`, updates `file_path`, and refuses an
existing destination. Outcomes stamp `metadata_status`
(`corrected|verified|no-source`) and `movedTo`.

Job control: `DELETE /api/jobs` batches (group `type`+`status`, default
`queued,running`, or explicit `ids`) through `cancelJobsByIds` → `cancelJob`, so
per-row SSE events stay identical to the UI's own buttons. `clearCompletedJobs`
deletes `succeeded|cancelled|failed|dead`. The reindex route enqueues with
`trackId` set (dedupe key — omitting it once produced 8000 jobs for 171 tracks),
priority −5, `force: true`, and `freshnessHours: 0` means a forced full pass
ordered nulls-first — bounded batches only.

## DB

Postgres via Drizzle. `tracks`, `jobs`, settings. Migrations in `drizzle/` as
numbered SQL. Notable columns: `download_status`
(`pending|completed|failed`), `refetch_blocked`, `force_tag_repair` (settings).

Shell-row reuse in `upsertTrack` only when the shell has no `file_path`, else
`(provider, provider_track_id)` collides. `ensureFailedTrackRow` returns early
when the row already owns a file — a failed upgrade must never null a completed
row's `file_path` and demote it to `failed`.

## Routes

`/api/tracks`, `/api/albums/[id]/download`, `/api/artists/[id]/download`,
`/api/playlists/[id]/download`, `/api/search`, `/api/jobs`, `/api/settings`.
Fan-out caps exist but a cap that truncates a request the user believes was
complete is worse than no cap — defaults now cover a full artist (100 albums /
1500 tracks) and `truncated` reports when a ceiling bites.

Artist and playlist fan-out is **Deezer-only**; the Tidal instance exposes no
route to them.

## Uploads

Anything with audio (mp3/flac/wav) plus ZIP. ZIP is expanded client-side with the
native `DecompressionStream` — no dependency — with traversal and zip-bomb guards,
and archive folder names are used as metadata hints. Uploads are enriched from
online sources when tags are absent.

## UI

Material 3, Svelte 5 runes, HugeIcons via `@hugeicons/svelte` +
`@hugeicons/core-free-icons`. Component classes live in `@layer components` in
`src/app.css` so Tailwind utilities win — unlayered CSS beats `@layer utilities`
unconditionally.

Jobs panel: rows bucket `type × status` into `<details>` groups (chevron when
multiplied, all summary children `shrink-0` so nothing crushes), ordered by a
deterministic `STATUS_RANK` (finished newest-first on top, running/queued FIFO,
failures last). The store (`events.svelte.ts`) owns status/progress truth —
filtered tabs map rows through `live.jobs` by id and re-fetch silently inside
the shared ~1/s reload throttle; error toasts fire only for non-retry terminal
failures (`onActivity`), which requires callbacks to register even when the SSE
stream was already opened by the layout.
