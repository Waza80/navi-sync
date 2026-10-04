# NaviSync 🛰️

Self-hosted, privacy-first **Navidrome companion**: download music from streaming
providers, enforce quality guardrails, fetch synced lyrics, and file everything
into a Navidrome-compatible library — all local, single-user, no telemetry.

**Phase 1 status:** working end-to-end (Deezer → FLAC/MP3 → tags → LRCLIB
lyrics → `Artist/Album/NN - Title` layout → Navidrome scan trigger), web UI on
port **7158**, live progress via Postgres `NOTIFY` → SSE (zero polling).

---

## Features (Phase 1)

- **Auth** — Better Auth (v1.7), email+password, Argon2id hashing, 7-day
  sessions with rotation, first user becomes `admin`, full audit log.
- **Download engine** — PostgreSQL-backed job queue (`FOR UPDATE SKIP LOCKED`),
  `NOTIFY`-driven wakeups, configurable concurrency (default 4), exponential
  backoff (30s→60s→120s), dead-letter + manual retry/cancel, graceful shutdown.
- **Deezer provider** — email/password → ARL session (AES-256-GCM encrypted at
  rest), gateway CSRF auto-recovery, quality negotiation (FLAC → MP3 320 →
  fallback), local Blowfish (BF_CBC_STRIPE) decryption, short-link resolution.
- **Lyrics manager** — priority traversal: LRCLIB (synced → plain) → Deezer
  pipe (synchronized). Sidecar `.lrc` / `.txt` next to audio. Loud failure
  logging for manual review. `downloadLyrics()` contract per spec.
- **Quality guardrails** — hard 24-bit ceiling, skip re-downloads when
  equal-or-better exists, configurable minimum bitrate + fallback policy.
- **Navidrome** — Subsonic API `ping` / `startScan`, credentials encrypted at
  rest, config UI + one-click scan.
- **UI** — dark Material 3 (baseline tokens), mobile-first (≥48px targets,
  bottom nav), WCAG-minded focus/contrast/aria, SSE-driven live queue.
- **Security** — rate limiting on all API routes (100 req/min/user + Better
  Auth's own), strict CSP with nonces, origin-checked mutations, structured
  JSON logs with secret redaction, parameterized queries everywhere.

## Stack

| Layer      | Tech                                             |
| ---------- | ------------------------------------------------ |
| Frontend   | SvelteKit 2 (Svelte 5 runes) + Tailwind 4        |
| Server/API | SvelteKit adapter-node (Bun runtime) @ 7158      |
| Auth       | Better Auth 1.7 (`@better-auth/drizzle-adapter`) |
| Database   | PostgreSQL 16+ (Drizzle ORM migrations)          |
| Runtime    | Bun ≥ 1.1 (node ≥ 22 also works)                 |

## Quickstart

```bash
# 0. Prereqs: Bun, PostgreSQL 16+ reachable
curl -fsSL https://bun.sh/install | bash

# 1. Configure
cp .env.example .env
# edit .env: DATABASE_URL, APP_SECRET (openssl rand -hex 32),
#            DEEZER_EMAIL / DEEZER_PASSWORD (quote values containing $)

# 2. Install + database
bun install
bun run db:create     # creates the `navisync` database (idempotent)
bun run db:migrate    # applies migrations (also auto-runs on server boot)

# 3. Run
bun run build
bun run start         # → http://localhost:7158

# Dev mode instead:
bun run dev           # vite dev on :5173 (auth origin pre-allowed for dev)

# 4. Open /login → "Create account" — the FIRST account becomes admin.
```

Docker (single service, external Postgres): see [docs/deployment.md](docs/deployment.md).

## Quality gates

```bash
bun run check   # svelte-check — 0 errors, 0 warnings
bun run lint    # eslint strict — 0 warnings allowed
bun run test    # vitest — core logic unit tests
bun run format  # prettier
```

## End-to-end smoke

```bash
bun run start &          # server on :7158
BASE=http://localhost:7158 bash scripts/smoke.sh
```

Validates: health, auth guards, signup, real Deezer download with live SSE
progress, library file verification, rate limiting.

## Repository layout

```
├── docker/            Dockerfile + compose
├── docs/              architecture, database, api, security, deployment,
│                      extensions + adr/ (decision records)
├── drizzle/           generated SQL migrations
├── scripts/           create-db / migrate / seed / smoke
└── src/
    ├── lib/server/    env, logger, crypto (AES-256-GCM), ratelimit,
    │                  auth (Better Auth), settings, db/ (drizzle schema),
    │                  queue/ (jobs, worker, handlers),
    │                  providers/ (registry + deezer: gateway/media/blowfish/parse),
    │                  lyrics/ (lrclib, deezer-pipe, manager),
    │                  library/ (paths, files, tagging),
    │                  navidrome/ (subsonic client)
    ├── lib/shared/    types, quality guardrails, formatters (+ tests)
    ├── lib/stores/    SSE live-event client (Svelte 5 runes)
    ├── lib/components/ M3 UI components
    └── routes/        (app) pages + /api REST + /api/events SSE
```

## Legal

NaviSync accesses Deezer with **your own credentials** and stores files for
**personal use with your own Navidrome instance**. This may violate Deezer's
Terms of Service in your jurisdiction — you assume all responsibility for use.
No credentials, keys, or user data ever leave your machine; there is no
telemetry anywhere in this codebase.

## License

TBD by project owner (dependency note: `blowfish-js` is GPL-2.0, isolated
behind `src/lib/server/providers/deezer/blowfish.ts` for easy swapping).
