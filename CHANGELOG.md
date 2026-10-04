# Changelog

All notable changes to NaviSync. Format: Keep a Changelog; semver.

## [0.3.0] — Phase 3: UI polish, link fan-out, covers, logging, security pass — 2026-10-04

### Added
- **Album/playlist link support**: `POST /api/tracks` accepts album and
  playlist links (incl. `link.deezer.com` short links) and fans out one
  download per track — verified live with 70-track playlist (11-track album).
- **Cover art everywhere**: search results map album art (Deezer
  `ALB_PICTURE` → CDN URL; Monochrome proxied artwork) through job payloads
  → every download now files a `cover.jpg`; search rows and album rows show
  thumbnails; track grid shows covers.
- **M3 motion & conventions**: emphasized-easing enter animations, hover
  lift on grid tiles, snackbar toasts on every action (queued/saved/
  cleared/errors), `prefers-reduced-motion` respected.
- **Search UX**: ✕ clear button, clearing the input resets results.
- **Non-invasive logging**: provider search timing, library-export
  completion, upload/sweep summaries (all redacted, local-only).

### Security
- Final pre-commit audit: no secrets in tree (`.env` gitignored + verified),
  logs redact credentials, DB stores only AES-256-GCM ciphertext, CSP +
  rate limits + origin checks active. Remote configured; push on request.

## [0.2.3] — Phase 2D: tracks.monochrome.st, chunked downloads, UI freeze fix — 2026-10-04

### Fixed
- **Dashboard freeze / unresponsive UI**: the snapshot-sync effect read and
  wrote reactive state in the same tracked scope → infinite self-trigger.
  Snapshot sync now runs `untrack()`. Regression-tested (5 new store tests:
  unknown-job progress application, whole-entry replacement, stale
  overwrite, prune, reconnect resync).
- **Instant dead-letter on first failure**: `claimNextJob` returned raw
  snake_case rows — `job.maxAttempts` was `undefined`, so `1 < undefined`
  skipped every retry. Claim rows are now mapped to the camelCase contract.
  Verified: failed downloads schedule retries (30s/60s/120s) properly.
- Restart script zombie bug (port-free wait was shorter than the drain
  window) + `/api/health` now exposes `bootedAt` so stale binaries are
  always detectable.

### Added
- **tracks.monochrome.st provider** (verified live end-to-end):
  `GET /search?q=` (rich results incl. ISRC/duration/artwork) and
  `GET /track/<id>` serving **raw decrypted FLAC** — no manifests/decryption
  needed client-side. Metadata travels with search-snapshot job payloads
  (bare ids have no metadata endpoint).
- **Parallel chunked downloader**: Cloudflare caps connections at ~512KiB/
  ~30s on these instances; downloads now use HTTP Range + 8 parallel
  workers (480KB chunks, per-chunk retry, offset writes, byte progress).
  Verified: 38.8 MB 24-bit/44.1kHz FLAC + synced LRCLIB lyrics end-to-end.
- Search-result metadata passthrough in `POST /api/jobs` (`meta` field).

## [0.2.2] — Phase 2C: Grid UI, album fan-out, ZIP export, forced upgrades, Monochrome auth — 2026-10-04

### Fixed
- **Queue reactivity**: missed SSE events (reconnect gaps) left stale entries
  forever — the authoritative snapshot now overwrites/prunes on every load,
  and "Clear finished" re-syncs via invalidateAll.
- **Phantom upgrade loop**: Deezer FLAC now claims its true 16-bit depth
  (`claimedBitDepth` on StreamResolution) so upgrade sweeps stop re-fetching
  identical files; Monochrome HI_RES correctly claims 24-bit.
- `/providers` SSR crash (synchronous form init), upload card spacing.

### Added
- **Track grid**: responsive M3 tile grid (2→5 columns) with album covers
  (`GET /api/tracks/:id/cover`), inline play/upgrade/download/delete.
- **Individual file download** (`GET /api/tracks/:id/file`, Content-Disposition).
- **ZIP export**: `GET /api/export` streams the whole library as a ZIP
  (store mode — audio is pre-compressed; ~35 MB/s observed, zero buffering).
- **Album search + fan-out**: `searchAlbums`/`albumTrackIds` (gw
  `search.music` ALBUM + `deezer.pageAlbum` SONGS.data) with album cover art;
  `POST /api/albums/:id/download` queues every track (guardrail dedupes).
  Dashboard search shows an Albums section with per-album download.
- **Forced quality check**: ⚡ button → `POST /api/tracks/:id/upgrade` →
  `upgrade_check` job (priority 8) — re-resolves the best stream with fresh
  metadata; strictly better versions download + refetch lyrics; otherwise
  reports "already at best".
- **Monochrome auth**: Better Auth sign-in against instances (email/password)
  AND Cloudflare-proof **session-cookie paste** (preferred); live search
  integration (`/search/?s=`); instance test performs a real search probe.

## [0.2.1] — Phase 2B: CSV import, search UI, preview, queue management, sweeps — 2026-10-04

### Added

- **Playlist/CSV import** (`POST /api/playlist/import`): supports Deezer
  library exports (exact `Deezer - id` + ISRC — zero guessing) and
  Spotify-style exports (ISRC → exact Deezer-id resolution via public API;
  strict title/artist/duration scoring as fallback). Unmatched rows are
  reported with reasons, never guessed. Handles BOM, quoted fields, both
  file layouts. Verified live: 37/38 Spotify rows matched (1 correctly
  refused — ISRC absent from Deezer); Deezer 44-row library import.
- **Provider search UI**: dashboard search card → `GET /api/search` fans out
  to every provider (`search.music` params fixed: `filter`+`output`), results
  tag-and-download in place. Verified live: 25 results for a Daft Punk query.
- **Song preview**: authenticated streaming endpoint with HTTP Range support
  (`/api/tracks/:id/audio`, 206 partials, seek-ready) + player bar in the UI.
- **Queue management**: status filters with live counts (All/Active/Done/
  Failed), "Clear finished" bulk cleanup, `result` payload in job listings.
- **Autonomous maintenance sweeps**: lyrics backfill (5 min — tracks without
  lyrics are retried on a 24h per-track backoff) and quality-upgrade sweep
  (hourly — asks providers for better streams below the 24-bit ceiling;
  upgrades refetch lyrics; a downed lyrics API never deletes existing
  sidecars). Manual "refetch lyrics" button removed per design change.
- **Upload dedupe**: title+artist library check — a song can never appear
  twice; duplicate uploads return the existing track.

### Fixed

- `/providers` page 500 on SSR (forms now initialize synchronously from the
  server snapshot).
- Upload card spacing.

## [0.2.0] — Phase 2A: Providers, Upload, Apple lyrics — 2026-10-04

### Added

- **Providers UI + API** (`/providers`): intuitive per-provider credential
  cards (select provider → fill fields → Save & verify). Deezer credentials
  moved from env-only to encrypted DB config (email+password or ARL), with
  live session test on save; ARL fallback now degrades to password grant.
  Monochrome (TIDAL proxy) provider: instance URL + Basic auth, quality
  tokens (HI_RES_LOSSLESS/LOSSLESS/LOW), `/trackManifests` → DASH MPD parsing
  → segment download/concat with progress (FLAC outputs).
- **Apple Music lyrics source** (ancientcatz method): web-player JWT scrape →
  amp-api catalog search → lyrics.paxsenix.org synced lines → LRC. Priority:
  LRCLIB → Apple Music → Deezer pipe. Verified live (Radiohead — Creep).
- **Manual upload with smart detection**: `/api/upload/inspect` probes real
  tags (music-metadata) + filename heuristics, returns detected/missing
  metadata for a prompted confirmation form; `/api/upload` finalizes —
  tagging, Navidrome layout filing, embedded-lyrics detection or LRCLIB
  fallback, track row (`provider='upload'`). `BODY_SIZE_LIMIT=500M`.
- **Navidrome compatibility verified against a live server** (ping + scan,
  Subsonic 1.16.1 responses OK).
- **UX**: sticky always-visible Save bar on Settings; partial-save semantics
  (blank Navidrome fields no longer wipe stored values); dashboard upload
  card with prompted metadata completion; explicit "Add to queue"/"Save to
  library" buttons (no Enter dependency); jobs API exposes `result`.

### Verified live

- Providers: Deezer save+verify (`Signed in as user …`), error path for
  unreachable Monochrome instances.
- Upload: inspect→finalize round-trip with prompted metadata (Creep re-filed,
  989 kbps/16-bit/44.1 kHz probed, synced lyrics).
- Monochrome DASH parser covered by fixture tests (timeline expansion,
  $Number%05d$ padding, init template resolution).

## [0.1.0] — Phase 1: MVP Foundation — 2026-10-04

### Added

- **Scaffold**: SvelteKit 2 + Svelte 5 (adapter-node, Bun runtime, port 7158),
  Tailwind 4, strict Prettier/ESLint (zero-warning gate), svelte-check clean.
- **Database**: PostgreSQL schema — Better Auth tables (user/session/account/
  verification) + `tracks`, `jobs`, `settings`, `provider_credentials`,
  `audit_log`; Drizzle migrations (auto-apply on boot); dev seed script.
- **Auth**: Better Auth 1.7 — email/password, Argon2id, 7-day sessions with
  daily refresh + cookie cache, first-user-becomes-admin hook, full audit log
  (signups, session lifecycle, IP+UA), Better Auth + custom rate limiting,
  origin canonicalization for multi-host access, telemetry explicitly disabled.
- **Queue**: PostgreSQL-backed jobs (FOR UPDATE SKIP LOCKED claims, NOTIFY
  wakeups, 10s safety poll), concurrency from settings (default 4), exponential
  backoff (30s/60s/120s) → dead-letter, manual retry/cancel with abort
  watcher, orphan recovery + temp purge on boot, graceful SIGTERM drain.
- **Deezer provider** (echo-deezer-extension method): email/password → ARL
  (curl transport fallback for TLS-fingerprint rejection), gateway CSRF
  auto-recovery, quality negotiation honoring policy, v2 media parsing
  (sources array / cipher object), short-link resolution, local Blowfish
  BF_CBC_STRIPE decryption (fixed IV scheme, verified live 2026-10),
  cover-art fetch, SHA-256 integrity, measured-quality probing (music-metadata).
- **Lyrics manager**: priority traversal (LRCLIB get→search → Deezer pipe
  GraphQL synced), `.lrc`/`.txt` sidecars adjacent to audio, loud failure
  logging + `failed` status for manual review, `downloadLyrics()` contract.
- **Library**: Navidrome layout `Artist/Album/NN - Title.ext`, path
  sanitization (traversal/Windows-safe, unit-tested), atomic move with
  content-diff dedupe, MP3 ID3v2.4 + FLAC Vorbis tagging, embedded cover for
  MP3 + `cover.jpg` for albums.
- **Navidrome**: Subsonic ping/startScan (md5 token auth), settings UI,
  scan-trigger job, credentials encrypted at rest (AES-256-GCM).
- **API**: tracks (list/create/delete incl. GDPR file erasure), jobs
  (list/cancel/retry), navidrome config + scan, lyrics refetch, health,
  SSE `/api/events` (zero-polling real-time), 501 stubs for Phase-2
  export/upload. Zod validation + typed errors everywhere.
- **UI**: dark Material 3 (baseline tokens, ≥48px targets, bottom nav,
  aria-live queue, focus-visible rings, skip links), live queue + track
  library + settings pages, SSE-driven updates (Svelte 5 runes store).
- **Security**: strict CSP (nonced scripts, frame-ancestors none), nosniff/
  DENY/no-referrer/COOP/Permissions-Policy headers, structured JSON logging
  with secret redaction + local rotation, AES-256-GCM credential vault,
  in-memory sliding-window rate limiter (100/min/user) with tests.
- **Quality gates**: 37 vitest unit tests (quality guardrails, path
  sanitization, rate limiter, Blowfish round-trip vs live-verified scheme,
  Deezer URL parsing, formatters), `bun run check` 0/0, `eslint
--max-warnings 0` clean.
- **Ops**: Dockerfile (oven/bun) + compose (healthcheck, optional local-db
  profile), create-db/migrate/seed/smoke scripts, `.env.example`.
- **Docs**: README, architecture (mermaid), database (ERD), API reference,
  security (threat model + GDPR), deployment, extensions guide, ADR-0001/2/3.

### Verified end-to-end (live, 2026-10-04)

- Deezer → FLAC (16-bit/44.1kHz measured) → tags → LRCLIB synced lyrics →
  `Artist/Album/NN - Title` layout → DB row → SSE progress, for canonical
  URLs and `link.deezer.com` short links; 24-bit guardrail skip proven;
  GDPR deletion; rate-limit 429; unauth 401; CSP/security headers active.

### Known limitations (deferred by phase)

- Album/playlist batch downloads, search UI, ZIP export, manual upload,
  folder watcher, OpenAPI spec, backup automation → Phase 2/3 (see README).
- Rate limiter is in-memory (single-process correct; Redis swap documented).
- FLAC embedded tags skipped when the stream lacks a VORBIS_COMMENT block
  (sidecar + folder art cover the Navidrome use case; injection planned).
