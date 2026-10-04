# Architecture

## Component overview (Phase 1 — Node monolith, ADR-0001)

```mermaid
flowchart LR
    subgraph client["Browser / PWA (mobile-first, dark M3)"]
        UI["SvelteKit pages\n(login, library, settings)"]
        ES["EventSource /api/events"]
    end
    subgraph server["navisync server (adapter-node on :7158, Bun runtime)"]
        HOOKS["hooks.server.ts\nsession · origin check · rate limit · headers"]
        AUTH["Better Auth\nArgon2id · sessions · audit"]
        API["REST /api/*\ntracks · jobs · navidrome · lyrics"]
        SSE["SSE endpoint\n/api/events"]
        WORKER["Job worker\nconcurrency N · backoff · DLQ"]
        DEEZ["Deezer provider\ngateway · media · blowfish"]
        LYR["Lyrics manager\nLRCLIB → Deezer pipe"]
        LIB["Library\ntagger · paths · files"]
        SUB["Subsonic client\nping · startScan"]
    end
    DB[("PostgreSQL 16+\nuser · session · account · verification\ntracks · jobs · settings · provider_credentials · audit_log")]
    DZ["deezer.com\nmedia.deezer.com\ncdnt-stream.dzcdn.net"]
    LR["lrclib.net"]
    ND["Navidrome\n(subsonic API)"]
    FS[("music/ library")]

    UI -->|fetch REST| HOOKS
    ES --> SSE
    HOOKS --> AUTH
    HOOKS --> API
    HOOKS --> WORKER
    AUTH --> DB
    API --> DB
    API --> NOTIFY1[pg_notify navi_jobs]
    WORKER --> DB
    WORKER --> DEEZ & LYR & SUB
    WORKER --> NOTIFY2[pg_notify navi_events]
    SSE -->|LISTEN navi_events| DB
    DEEZ --> DZ
    LYR --> LR
    SUB --> ND
    LIB --> FS
```

## Request/queue flow (download)

```mermaid
sequenceDiagram
    actor U as Browser
    participant API as POST /api/tracks
    participant DB as PostgreSQL
    participant W as Worker (in-process)
    participant D as Deezer
    participant L as LRCLIB
    U->>API: {url}
    API->>API: zod validate · rate limit · provider parse
    API->>DB: INSERT job (queued)
    API->>DB: pg_notify('navi_jobs')
    DB-->>W: NOTIFY wakeup (or 10s safety poll)
    W->>DB: claim job (FOR UPDATE SKIP LOCKED)
    W->>D: song.getData · public API enrich
    W->>D: media/v1/get_url (FLAC→MP3 320→128 by policy)
    W->>D: stream download → tmp
    W->>W: Blowfish BF_CBC_STRIPE decrypt (fixed IV, 2048÷3)
    W->>W: music-metadata probe (measured quality)
    W->>L: /api/get → /api/search (synced → plain)
    W->>W: tag (node-id3 / flac Vorbis) · move into Artist/Album/
    W->>DB: upsert track · job succeeded
    W->>DB: pg_notify('navi_events') at every stage
    DB-->>U: SSE progress (no polling anywhere)
```

## Key decisions

- **ADR-0001 — Node-first monolith** (owner decision): everything in one
  SvelteKit process. The Tauri/Rust engine was deferred; the seams to extract
  it are already in place (ADR-0002).
- **ADR-0002 — PostgreSQL is the only bus**: jobs are claimed with
  `FOR UPDATE SKIP LOCKED`, wakeups and progress travel over `NOTIFY`
  channels. A future Rust engine becomes just another consumer — no API
  changes.
- **ADR-0003 — Deezer method** mirrors LuftVerbot/echo-deezer-extension:
  email/password → ARL, gateway with CSRF recovery, `media/v1/get_url`,
  local Blowfish decryption (fixed IV `0001020304050607`, 2048-byte stripes,
  every 3rd encrypted — verified against live streams 2026-10). No
  third-party resolvers by default (`DEEZER_RESOLVER_URL` optional fallback).

## Data flow guarantees

1. **Real-time without polling**: enqueue → `pg_notify('navi_jobs')` → worker
   wake; progress → `pg_notify('navi_events')` → SSE → `EventSource`. The 10s
   poller is a safety net, not the mechanism.
2. **Measured quality**: DB stores what `music-metadata` probed from the
   decrypted file, never provider claims.
3. **Integrity**: SHA-256 over decrypted bytes stored per track; temp files
   cleaned in `finally`-style paths + stale purge on boot.
4. **Failure semantics**: retryable failures → backoff (30s/60s/120s); final
   failure → `dead` (dead-letter) with actionable error; user cancel →
   `cancelled` via abort watcher; SIGTERM → drain ≤ 30s.

## Phase-2/3 seams (already present)

- `providers/registry.ts` — ordered provider chain for multi-source routing.
- `jobs.type` — `export` and future types plug into the same dispatcher.
- `pg-events.ts` + queue contract — drop-in Rust/Tauri engine later.
- `lyricsSources[]` — add sources by appending to the traversal list.
