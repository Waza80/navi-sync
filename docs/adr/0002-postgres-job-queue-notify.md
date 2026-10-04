# ADR-0002 — PostgreSQL as the only bus (jobs + events)

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

The download engine must report real-time progress to browsers, support
cancel/retry/dead-letter, configurable concurrency, and (eventually) run as
a separate Tauri/Rust process. The spec mandates a PostgreSQL-backed job
table, Postgres-notification reactivity (no polling), and Redis only as an
optional preference.

## Decision

PostgreSQL is the **only** inter-component contract:

- **Queue**: `jobs` table; claim via
  `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED …) RETURNING *`
  (multiple claimants safe by construction).
- **Wakeups**: `pg_notify('navi_jobs')` on enqueue/retry + 10s safety poller.
- **Events**: `pg_notify('navi_events')` with the `NaviEvent` JSON contract
  (`src/lib/shared/types.ts`), fanned out to browsers via one `LISTEN`
  connection → SSE (`/api/events`).

## Consequences

**Positive**

- Exactly-once job execution across any number of workers/processes
  (validated live during Phase 1 when a stale dev server raced the new one).
- No polling in UI or worker hot paths; NOTIFY latency ≈ instant.
- Zero new infrastructure (no Redis in the critical path for Phase 1).
- Rust/Tauri engine extraction later = new consumer, zero API changes.

**Negative / mitigations**

- NOTIFY payloads capped at ~8KB → events carry ids/progress only.
- Lost NOTIFYs (DB restart) → 10s safety poller; at-least-once claim design.
- In-process worker shares the event loop with HTTP → streaming I/O and
  chunked crypto; profile before adding CPU-bound stages.

## Alternatives considered

- Redis Streams/BullMQ — extra infra, contradicts "Postgres-backed job
  table" mandate (kept as the documented scale-out swap for the rate limiter).
- HTTP callbacks engine→web — requires web→engine auth surface; NOTIFY is
  simpler and survives web restarts.
