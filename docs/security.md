# Security

Threat model, controls, and compliance notes for a single-user, self-hosted
deployment. Principle: **fail fast, encrypt at rest, zero external calls.**

## Asset inventory & entry points

| Asset                         | Where                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| Deezer credentials (email/pw) | `.env` (disk, gitignored) → derived ARL session in `provider_credentials` (AES-256-GCM) |
| Navidrome credentials         | `settings` row, password column AES-256-GCM                                             |
| `APP_SECRET`                  | `.env`; derives session signing + AES key                                               |
| Music library                 | `music/` (bind-mountable, Navidrome-readable)                                           |
| Personal data                 | user email, session IPs, audit log                                                      |

Entry points: HTTP API (auth-gated, rate-limited), the music library
directory, and outbound calls to Deezer/LRCLIB/Navidrome (allowlisted hosts
in code; no user-controlled URL fetch except provider-track URLs).

## Controls (Phase 1 — implemented)

| Threat                      | Control                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Credential theft at rest    | AES-256-GCM (key = SHA-256(APP_SECRET)) for Navidrome + Deezer sessions; APP_SECRET ≥32 chars enforced at boot                       |
| Credential theft in logs    | Structured logger **redacts** keys matching password/token/arl/secret/email/cookie; no external transports                           |
| Credential theft in VCS     | `.env` gitignored (verified before first commit); `.env.example` placeholders only                                                   |
| Brute force / abuse         | Better Auth rate limit (30/min on auth) + per-user API limiter (100/min, sliding window) → 429 + `Retry-After`                       |
| CSRF                        | SvelteKit content-type checks + explicit `Origin` check on all API mutations; Better Auth trusted-origins (same-host dynamic)        |
| XSS                         | Svelte auto-escaping; CSP `default-src 'self'`, script nonce (`mode:'auto'`), `object-src 'none'`, `frame-ancestors 'none'`          |
| Clickjacking                | `X-Frame-Options: DENY` + `frame-ancestors`                                                                                          |
| SQL injection               | Drizzle parameterized queries exclusively; the only dynamic SQL (job claim) uses bound parameters                                    |
| Path traversal (library)    | `sanitizeComponent()` strips `/\:*?"<>                                                                                               | `, control chars, leading dots, Windows reserved names; unit-tested |
| Session theft               | HttpOnly SameSite=Lax cookies, Argon2id password hashing (19MiB/t=2/p=1), 7-day expiry + daily refresh, DB-stored sessions revocable |
| Malicious provider response | Downloaded media only written under sanitized library paths; cover art size-clamped (1KB–15MB); no response content executed         |
| Supply chain (crypto)       | Node stdlib only for AES/MD5/SHA; pure-JS Blowfish isolated in one swappable module (GPL-2.0 note in README)                         |

## HTTPS

Terminate TLS at a reverse proxy (Caddy example in deployment.md) and set
`USE_SECURE_COOKIES=true` + `ORIGIN=https://your.domain` + HSTS (sent
automatically when secure cookies are on). Local HTTP on LAN is acceptable
only if you accept LAN exposure; cookies are `SameSite=Lax` + HttpOnly
regardless.

## GDPR

| Requirement             | Implementation                                                                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lawfulness / minimality | Single user; stores email, IP, UA, music library — nothing else; no analytics, no telemetry (Better Auth `telemetry:{enabled:false}` explicit)                                                                                                                    |
| Right to erasure        | `DELETE /api/tracks/:id` (row + files); user deletion cascades sessions/accounts; audit rows for the user are retained as pseudonymous markers (configurable to purge — Phase 3 hardening item)                                                                   |
| Data portability        | Library is plain files + DB; ZIP export Phase 2                                                                                                                                                                                                                   |
| IP as personal data     | `session.ip_address`, `audit_log.ip_address`; behind a proxy set `x-forwarded-for` so the proxy IP isn't recorded instead; **retention**: default keep-forever for single-user ops — set a cron to prune `audit_log` older than N days if your policy requires it |
| Breach notice           | All secrets encrypted at rest; DB exposure does not yield usable credentials                                                                                                                                                                                      |

## Known gaps (tracked for Phase 3)

1. Rate limiter is in-memory — horizontal scale needs Redis (documented swap point in `ratelimit.ts`).
2. `audit_log` purge automation.
3. OpenAPI spec + Swagger UI.
4. Backup automation (DB dump + library rsync scripts).
5. Dependency audit job (`bun audit` in CI).

## Vulnerability handling

Self-hosted project: report privately to the maintainer. Security-relevant
fixes are committed with `security:` prefix and noted in CHANGELOG.
