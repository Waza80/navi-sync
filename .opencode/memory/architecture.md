# Architecture

## Providers

`src/lib/server/providers/` — registry order is precedence.

| Provider | Streams | Notes                                                                                                                                                                                                 |
| -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tidal`  | Yes     | Self-hosted `hifi-api` instance. fMP4 demuxed to FLAC in pure TS (`tidal/mp4.ts`) — the production image has no ffmpeg. No artist-track or playlist endpoint (`/artist/albums/`, `/playlist/` → 404). |
| `deezer` | Yes     | Needs a gateway (`DEEZER_RESOLVER_URL`) for album→track and artist album listings; the public API returns `InvalidQueryException` for song ids.                                                       |

A `Provider` exposes: `parseRef`, `matches`, `metadata`, `search`, `resolve`,
optional `findByIsrc` / `findByIsrcInAlbum` / `albumTracks` / `albumTrackIds` /
`artistAlbumIds` / `playlistTrackIds` / `searchArtists`.

`TrackRef.kind` defaults to `'track'` but is load-bearing: a Deezer artist id is
shaped exactly like a song id, so without it the pipeline calls `song.getData`
with an artist id and reports a gateway fault instead of the real problem.
`runDownload` refuses any ref whose kind is not `'track'`; `matches()` still
accepts those URLs so `/api/search` can classify a pasted link and offer fan-out.

## Queue

`src/lib/server/queue/` — `jobs.ts` (store), `worker.ts` (drain), `handlers.ts`
(job bodies), `relocate.ts` (re-finding a track elsewhere), `upgrades.ts`.

Download handler order: route → parse ref → metadata → enrich missing →
quality guardrail → resolve stream → download → verify integrity → tag →
lyrics → file into library → embed lyrics → persist row.

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
