# API

Base: `http://<host>:7158` · All `/api/*` require a session cookie except
`/api/health` and `/api/auth/*` (Better Auth endpoints). Mutations require a
same-origin `Origin` header or an entry in `TRUSTED_ORIGINS`. Rate limit:
100 req/min per user (429 + `Retry-After` beyond). OpenAPI spec lands in
Phase 2; this page is the contract.

Error shape (non-2xx):

```json
{ "error": { "code": "RATE_LIMITED", "message": "Rate limit exceeded. Retry in 42s." } }
```

## Auth — `/api/auth/*` (Better Auth v1.7)

| Endpoint                  | Method | Notes                                                                |
| ------------------------- | ------ | -------------------------------------------------------------------- |
| `/api/auth/sign-up/email` | POST   | `{name, email, password}` (min 10 chars). First user → `role: admin` |
| `/api/auth/sign-in/email` | POST   | `{email, password}` → session cookie                                 |
| `/api/auth/sign-out`      | POST   | destroys session                                                     |
| `/api/auth/get-session`   | GET    | current `{ user, session }`                                          |

Requests to `/api/auth/*` are canonicalized to `BETTER_AUTH_URL` origin
server-side, so any host that can reach the server works (localhost, LAN IP,
domain). CSRF: same-host origins are trusted; extras via `TRUSTED_ORIGINS`.

## Tracks

| Endpoint          | Method | Body/Query                   | Response         |
| ----------------- | ------ | ---------------------------- | ---------------- |
| `/api/tracks`     | GET    | `?q=&page=&pageSize=` (≤100) | `{items, total}` |
| `/api/tracks`     | POST   | `{"url": "<deezer track url  | id>"}`           | `201 {job}` |
| `/api/tracks/:id` | GET    | —                            | `{track}`        |
| `/api/tracks/:id` | DELETE | — GDPR erasure: row + files  | `{deleted, id}`  |

`POST /api/tracks` accepts canonical URLs, `link.deezer.com` short links, or
bare numeric ids. Re-downloads of equal/lower quality than an existing track
are **skipped by the guardrail** (job succeeds with `result.skipped`).

## Jobs

| Endpoint              | Method | Notes                                                |
| --------------------- | ------ | ---------------------------------------------------- |
| `/api/jobs?limit=`    | GET    | newest first (≤100)                                  |
| `/api/jobs`           | POST   | `{"url"}` — alias of `POST /api/tracks`              |
| `/api/jobs/:id`       | DELETE | cancel queued (immediate) or running (abort watcher) |
| `/api/jobs/:id/retry` | POST   | manual retry of `dead                                | failed | cancelled` |

## Events — `GET /api/events` (SSE)

`text/event-stream` of `navi_events` NOTIFY payloads:

```
event: hello
data: {"type":"hello",...}

data: {"type":"job.progress","jobId":"…","progress":42,"stage":"downloading …","ts":"…"}
data: {"type":"job.completed","jobId":"…","result":{…},"ts":"…"}
data: {"type":"job.failed","jobId":"…","error":"…","willRetry":true,"ts":"…"}
data: {"type":"job.cancelled", …}
```

Event types: `job.queued · job.progress · job.completed · job.failed ·
job.cancelled`. Heartbeat every 25s; auto-reconnect (`retry: 3000`).

## Albums (Phase 2)

| Endpoint                   | Method | Notes                                                                |
| -------------------------- | ------ | -------------------------------------------------------------------- |
| `/api/albums/:id/download` | POST   | fan-out: enqueue every track of the album (202 `{enqueued, jobIds}`) |

`POST /api/tracks` also accepts **album/playlist links** (incl.
`link.deezer.com` short links) — response `202 {kind, enqueued, jobIds}`.

## Per-track files (Phase 2)

| Endpoint                   | Method | Notes                                                           |
| -------------------------- | ------ | --------------------------------------------------------------- |
| `/api/tracks/:id/file`     | GET    | authenticated download (attachment)                             |
| `/api/tracks/:id/cover`    | GET    | album art (jpeg)                                                |
| `/api/tracks/:id/audio`    | GET    | HTTP Range streaming (preview seeking)                          |
| `/api/tracks/:id/upgrade`  | POST   | force quality check now (202 `{job}`)                           |
| `/api/tracks/retry-failed` | POST   | force-retry ALL failed downloads now (202 `{requeued, jobIds}`) |

## Navidrome

| Endpoint                | Method | Body                                                                                                                                   | Notes                                                                                                               |
| ----------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/api/navidrome`        | GET    | —                                                                                                                                      | config (no password echo; `hasNavidromePassword`)                                                                   |
| `/api/navidrome`        | PUT    | `{navidromeUrl?, navidromeUsername?, navidromePassword?, minBitrateKbps?, preferLossless?, allowLowerFallback?, concurrentDownloads?}` | password stored AES-256-GCM encrypted                                                                               |
| `/api/navidrome/scan`   | POST   | `{}` enqueue scan · `{"pingOnly":true}` synchronous test                                                                               | scan job waits for completion, stamps synced rows                                                                   |
| `/api/navidrome/repair` | POST   | `{}` — ping + disk/DB inventory, then a scan job that waits for completion                                                             | 202 `{job, filesOnDisk, tracksInDb, serverVersion}`; job result carries `scanCompleted`, `lastScanCount`, `stamped` |

## Lyrics

| Endpoint                     | Method | Notes                            |
| ---------------------------- | ------ | -------------------------------- |
| `/api/lyrics/fetch/:trackId` | POST   | enqueue lyrics job (202 `{job}`) |

## Health & planned

| Endpoint      | Method | Notes                                                    |
| ------------- | ------ | -------------------------------------------------------- |
| `/api/health` | GET    | `{status:'ok', db, uptimeSec, version}` — 503 if DB down |
| `/api/export` | GET    | **501** — Phase 2 (streaming ZIP)                        |
| `/api/upload` | POST   | **501** — Phase 2                                        |

## curl walkthrough

```bash
J=/tmp/jar
curl -c $J -H 'Origin: http://localhost:7158' -H 'content-type: application/json' \
  -d '{"name":"admin","email":"me@example.com","password":"longpassword1"}' \
  http://localhost:7158/api/auth/sign-up/email

curl -b $J -H 'Origin: http://localhost:7158' -H 'content-type: application/json' \
  -d '{"url":"https://www.deezer.com/track/3135556"}' \
  http://localhost:7158/api/tracks

curl -N -b $J http://localhost:7158/api/events   # live progress
curl -b $J http://localhost:7158/api/tracks      # library
```
