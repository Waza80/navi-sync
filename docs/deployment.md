# Deployment

## Environment variables

| Variable              | Required | Default                  | Notes                                                                                 |
| --------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------- | ---- | ---- | ------ |
| `DATABASE_URL`        | ✔       | —                        | `postgres://user:pass@host:5432/navisync`                                             |
| `APP_SECRET`          | ✔       | —                        | ≥32 chars (`openssl rand -hex 32`); signs sessions + derives AES key                  |
| `BETTER_AUTH_URL`     |          | `http://localhost:$PORT` | Public base URL; must match what browsers use                                         |
| `ORIGIN`              | rec.     | —                        | Pins adapter-node origin (required under Bun; set to same value as `BETTER_AUTH_URL`) |
| `TRUSTED_ORIGINS`     |          | empty                    | Comma-separated extra origins allowed for auth CSRF                                   |
| `PORT` / `HOST`       |          | `7158` / `0.0.0.0`       | `127.0.0.1` restricts to localhost                                                    |
| `MUSIC_LIBRARY_DIR`   |          | `./music`                | Must be the directory Navidrome scans                                                 |
| `MUSIC_TMP_DIR`       |          | `./.tmp`                 | Scratch space (auto-cleaned)                                                          |
| `LOG_LEVEL`           |          | `info`                   | `debug                                                                                | info | warn | error` |
| `USE_SECURE_COOKIES`  |          | `false`                  | `true` behind HTTPS (+HSTS auto)                                                      |
| `DEEZER_EMAIL`        | opt.     | —                        | Derives ARL session once; quote values containing `$`                                 |
| `DEEZER_PASSWORD`     | opt.     | —                        | Stored only as encrypted session afterwards                                           |
| `DEEZER_RESOLVER_URL` | opt.     | —                        | External dzmedia-compatible fallback; empty = local decryption                        |

> `.env` loader nuances: Bun strips single quotes; keep `unquote()`
> normalization in `src/lib/server/env.ts` — it makes quoted secret values
> safe under both Bun and `node --env-file`.

> **Container is ground truth.** The production container's database is the
> authoritative library. Local dev must use its **own** database (e.g.
> `navisync_dev`) and its own `MUSIC_LIBRARY_DIR` so the two volumes never
> merge. Create it with `DATABASE_NAME=navisync_dev bun run db:create` and
> point local `.env` at it.

## Docker Compose (single service, external Postgres)

```bash
cp .env.example .env   # fill in
docker compose -f docker/compose.yaml up -d --build
# app on :7158, migrations auto-apply on boot
```

Optional bundled Postgres: `docker compose -f docker/compose.yaml --profile local-db up -d`
(`DATABASE_URL=postgres://postgres:navisync@db:5432/navisync` inside the network).

## Bare metal / systemd

```bash
bun install && bun run build
DATABASE_URL=… APP_SECRET=… ORIGIN=http://your.host:7158 bun ./build/index.js
```

```ini
# /etc/systemd/system/navisync.service
[Unit]
Description=NaviSync
After=network-online.target

[Service]
User=navisync
WorkingDirectory=/opt/navisync
EnvironmentFile=/opt/navisync/.env
ExecStart=/home/navisync/.bun/bin/bun ./build/index.js
Restart=on-failure
# Graceful worker drain on deploy:
KillSignal=SIGTERM
TimeoutStopSec=40

[Install]
WantedBy=multi-user.target
```

## Reverse proxy (HTTPS)

```caddy
# Caddyfile — automatic TLS
navi-sync.example.com {
    reverse_proxy 127.0.0.1:7158
}
```

Then in `.env`: `ORIGIN=https://navi-sync.example.com`,
`BETTER_AUTH_URL=https://navi-sync.example.com`,
`USE_SECURE_COOKIES=true`, `TRUSTED_ORIGINS=https://navi-sync.example.com`.

nginx equivalent: proxy `Host`, `X-Forwarded-For`, `X-Forwarded-Proto` and set
`PROTOCOL_HEADER=X-Forwarded-Proto`, `HOST_HEADER=X-Forwarded-Host`.

## Navidrome wiring

Point Navidrome's `MusicFolder` at the same directory NaviSync writes
(`MUSIC_LIBRARY_DIR`) — same-host bind mount, NFS share, or sync (rsync /
Syncthing) to the Navidrome host. Then configure Navidrome in Settings →
Test connection → Trigger scan. Layout produced:

```
Music/
└── Artist/Album/NN - Title.flac|.mp3
                ├── NN - Title.lrc   (synced lyrics)
                └── cover.jpg
```

## Updates

```bash
git pull && bun install && bun run build
systemctl restart navisync   # migrations auto-apply on boot
```

## Backups (manual until Phase 3 automation)

```bash
pg_dump "$DATABASE_URL" > navisync-$(date +%F).sql
tar czf library-$(date +%F).tgz music/
```
