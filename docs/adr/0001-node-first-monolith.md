# ADR-0001 — Node-first monolith for Phase 1

- **Status:** Accepted (owner decision, Phase 1 kickoff)
- **Deciders:** project owner, architect
- **Date:** 2026-10-04

## Context

The mandated stack includes Tauri/Rust (engine) and Better Auth (TS-only
auth framework). Better Auth cannot run inside a Rust process, so the
original proposal split the system: SvelteKit (UI/auth/REST/SSE, port 7158)

- Rust engine coupled only through PostgreSQL (ADR-0002).

## Decision

**Phase 1 is a Node-first monolith**: one SvelteKit process (adapter-node,
Bun runtime) owns UI, Better Auth, REST/SSE **and** the download engine
(in-process worker). Tauri/Rust is deferred. Owner chose this from three
options for fastest time-to-first-working-flow.

## Consequences

**Positive**

- Single deployment artifact; simplest ops for a single-user tool.
- One language across the pipeline; fastest iteration on provider quirks.
- The Postgres queue contract (ADR-0002) is preserved from day one, so a
  Rust engine can be extracted later without API changes.

**Negative / mitigations**

- Downloads compete for the Node event loop → mitigations: streaming I/O
  (no full-file buffering), worker loops are async, CPU-heavy Blowfish is
  chunked; revisit if profiling shows starvation.
- Dev-mode footgun: vite dev + production server share the DB queue — two
  workers with different code versions race for jobs (observed during
  Phase-1 debugging; documented here). Mitigation: only one instance during
  development; the design intentionally allows this for production HA later.

## Alternatives considered

1. **Rust-only + custom auth** — one process, but abandons Better Auth and
   the SvelteKit server; more auth code to own (rejected).
2. **Split process (original proposal)** — cleanest long-term; slower to
   first working flow (deferred, not rejected — see ADR-0002 exit plan).
