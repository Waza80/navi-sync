# Database

PostgreSQL 16+ · Drizzle ORM · migrations in `drizzle/` (applied
automatically, idempotently, on server boot; manual: `bun run db:migrate`).

Create the dedicated database first: `bun run db:create` (defaults to
`navisync`; override with `DATABASE_NAME`).

## ER diagram

```mermaid
erDiagram
    user ||--o{ session : "has"
    user ||--o{ account : "authenticates via"
    user ||--o{ jobs : "created by"
    user ||--o{ audit_log : "audited"
    tracks ||--o{ jobs : "referenced by"

    user {
        text id PK
        text name
        text email UK
        boolean email_verified
        text role "admin | user (first user = admin)"
        timestamptz created_at
        timestamptz updated_at
    }
    session {
        text id PK
        text token UK
        text user_id FK
        timestamptz expires_at
        text ip_address "personal data — see security.md"
        text user_agent
    }
    account {
        text id PK
        text provider_id "credential provider"
        text user_id FK
        text password "argon2id hash"
    }
    verification {
        text id PK
        text identifier
        text value
        timestamptz expires_at
    }
    tracks {
        uuid id PK
        text provider "e.g. deezer"
        text provider_track_id "unique per provider"
        text title
        text artist
        text album
        text isrc "guardrail key"
        integer track_number
        integer duration_sec
        text format "mp3 | flac (probed)"
        integer bitrate_kbps "measured"
        integer bit_depth "measured — 24 = ceiling"
        integer sample_rate_hz "measured"
        boolean is_lossless "measured"
        bigint size_bytes
        text checksum_sha256 "of decrypted bytes"
        text file_path
        text cover_path
        text lyrics_status "none | synced | plain | failed"
        timestamptz navidrome_synced_at
    }
    jobs {
        uuid id PK
        text type "download | lyrics | navidrome_scan | export"
        text status "queued | running | succeeded | failed | dead | cancelled"
        integer priority "DESC"
        jsonb payload
        smallint progress "0..100"
        text stage
        jsonb result
        text error
        integer attempts
        integer max_attempts "default 3"
        timestamptz run_after "backoff target"
        uuid track_id FK
        text created_by FK
    }
    settings {
        text id PK "'default' singleton"
        text navidrome_url
        text navidrome_username
        text navidrome_password_enc "AES-256-GCM"
        text library_path
        integer min_bitrate_kbps "default 320"
        boolean prefer_lossless "default true"
        boolean allow_lower_fallback "default true"
        integer concurrent_downloads "default 4"
    }
    provider_credentials {
        text id PK "provider id, e.g. 'deezer'"
        text data_enc "AES-256-GCM session JSON"
    }
    audit_log {
        text id PK
        text user_id
        text event "auth.user.created · auth.session.* ..."
        text ip_address "personal data"
        text user_agent
        jsonb metadata
    }
```

## Index design

| Table       | Index                                          | Purpose                                |
| ----------- | ---------------------------------------------- | -------------------------------------- |
| `tracks`    | `UNIQUE(provider, provider_id)`                | dedupe + upsert target                 |
| `tracks`    | `isrc`, `artist`, `created_at`                 | guardrail lookup, listing, sort        |
| `jobs`      | `(status, priority, run_after)`                | claim query (`SKIP LOCKED`) — hot path |
| `session`   | `user_id`                                      | auth joins                             |
| `audit_log` | `(user_id, created_at)`, `(event, created_at)` | anomaly review                         |

Performance: track listing is server-paginated (≤100/page) over indexed
columns — the 1000-track <500ms budget holds trivially at Phase-1 scale.

## Seed data

`bun run db:seed` (dev only, refuses any database not named `navisync`):
ensures the `settings` singleton. Users are **not** seeded — create the first
account via `/login` (databaseHook promotes it to `admin`).

## GDPR notes

- `DELETE /api/tracks/:id` removes the row **and** audio/lyrics/cover files.
- User deletion (`DELETE /api/auth/delete-user` or admin action) cascades
  sessions/accounts; audit_log retains an anonymizable marker — see
  [security.md](security.md#gdpr).
- IPs are personal data: recorded in `session.ip_address` and `audit_log`
  only; retention policy in [security.md](security.md).
