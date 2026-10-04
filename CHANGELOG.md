# Changelog

All notable changes to NaviSync. Format: Keep a Changelog; semver.

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
