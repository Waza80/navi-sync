# Operations

## Access

- App: `https://navis.orbitsc.net` — health reports `db: true` and `uptimeSec`,
  which is how you detect a deploy.
- Navidrome: `https://navi.orbitsc.net`.
- **The music library lives at `/mnt/hdd/music` on `192.168.1.24`, NOT on this host.**
  Reach it with `ssh wyzz@192.168.1.24`. Anything that touches library _files_ —
  deleting duplicates, repairing tags, checking what is actually on disk — has to run
  over there; the app container sees it as `/music`. Do not conclude a file is
  missing from an empty local `/mnt/hdd/music`: the mount simply is not present here.
  Verify with `ssh wyzz@192.168.1.24 'ls /mnt/hdd/music'` before concluding anything
  about library contents.
- Production DB: `postgres://…@192.168.1.24:3593/navisync`, read from
  `docker/compose.prod.yaml` (gitignored). Dev DB is port `3945/navisync_dev`.
  **Direct connections from this host are flaky** — ECONNREFUSED or timeouts even
  though the app reaches the same DB fine. Retry in a loop, or query through the
  authenticated API.
- Credentials live in `.env` and `docker/compose.prod.yaml`. Never copy them into
  a tracked file, a commit message, or a shell command that lands in history.

## Deploy

Push to `main`; a webhook builds and deploys. Poll `/api/health` until
`uptimeSec` drops below ~300.

**Never deploy through the Coolify API.** Project `jnmaubqjxevu1xhxv3gcvzqg`; app
`v9xesowzl3icpzhi1hvpnmrp`; HiFi instance `idddhwsebnmpz2sbgaytqzrw`. These IDs
are for _reading_ status only.

## Verification recipes

Library truth, production DB:

```sql
-- state at a glance
select count(*) rows, count(file_path) audio,
       count(*) filter (where download_status='failed') failed,
       count(*) filter (where refetch_blocked) blocked
from tracks;
```

**One file, one row**: `tracks_file_path_uq` partial unique index (added in
`0013_single_file_owner`) prevents two rows pointing at the same audio. The delete
route checks `countOtherTracksWithFilePath` and keeps the file when another row still
references it. Deleting one duplicate never breaks the other.

**Post-download scans**: gated by the `autoScan` setting (default on). A scan already
queued/running or one that ran in the last 10 minutes is skipped. Non-repair scans
trigger-and-return — they never occupy a worker slot while polling, and the cancel
button works because `runNavidromeScan` observes `ctx.signal` between polls. Repair
scans still await completion and stamp `navidrome_synced_at`.

**MusicBrainz / BrainzMash**: `MUSICBRAINZ_BASE_URL` defaults to the BrainzMash
mirror (4 req/sec) and falls back to official MusicBrainz (1 req/sec) on 403/429/5xx
or network failure. BrainzMash answers with the app's `Lidarr/2.0.0.5284` UA and
403s any other UA — a probe with a custom UA looks "blocked" when it is not
(verified 2026-10-25: 200s with the Lidarr UA from the dev host). Official
MusicBrainz sheds bursts with HTTP 503 `busy` even at the polite rate: space
probe requests ≥3s apart or the first one fabricates a `no-source` result.

-- why jobs died
```sql
select left(error,150) reason, count(*) n from jobs
where type='download' and status='dead' group by 1 order by 2 desc;

-- album-wide failure is the signature of a rights block, not a flaky request
select album, count(*) n, count(file_path) audio from tracks
where artist ilike '%X%' group by 1 having count(file_path) < count(*);
```

There is no `psql` on this host — use a throwaway `bun` script with `pg` from
`/tmp/opencode`.

Live provider probes: import `providers` from
`src/lib/server/providers/registry` and run with `.env` sourced. Load order
matters — source `.env` _before_ `bun`, or `env.ts` throws on a missing
`APP_SECRET`. Then export the REAL `DATABASE_URL` (prod `/navisync`) and run the
script from `/tmp/opencode`: `env.ts` uses `config({ override: true })`, so a
`.env` present in cwd silently beats any exported value, while `/tmp` has none.

Authenticated API probes (reindex, upgrade, scan, cancel): register
`ops-sweep@navisync.local` (first user ever registered is admin; this one is a
normal user — every route only needs `locals.user`). Sign in with
`POST /api/auth/sign-in/email` saving cookies to `/tmp/opencode/ops_cookies.txt`;
requests need an `Origin` header (sameOrigin check). The `session_data` cookie
expires in ~5 minutes → 401 `UNAUTHENTICATED` — just sign in again (the
7-day token alone is not enough).

**Navidrome ghost purge is standing config**: `navidrome.toml` beside the DB
(`/data/coolify/services/f0dgcamrsobomncvavlw85lo/data/`) sets
`Scanner.PurgeMissing = "always"` — every scan removes rows whose files were
deleted or moved, so the UI-delete step of the bulk-move recipe is no longer
manual. The Navidrome DB itself sits next to it (`navidrome.db`, sqlite; the
host has `python3`, not `sqlite3` CLI). Verification invariant after any bulk
operation: `select count(*), sum(missing) from media_file` must equal the
production `tracks` filed count with `missing = 0`.

## Working rules

- **Commit and push are the same thing — one means both.** A commit that is
  not pushed is not done; ship them together unless explicitly told to hold.
- **Simulate before any real change.** Red fixture tests first, then the
  implementation; for library operations the tool's own dry-run (e.g.
  `scripts/reconcile-library.ts` without `--apply`, probe-only reindex calls)
  must print the exact expected effect BEFORE the apply run. The first
  execution of a destructive rule never touches the production library.

## Known unreconciled items

- Duplicate library files from suffixed moves (`song (2).flac`, `(3).flac`) affected
  211 rows across 93 albums. **A higher suffix is a LATER fetch and may be the better
  file** — never keep the unprefixed copy by default; compare before deleting.
- `cover (4).jpg` … `cover (7).jpg` accumulate in `The Long Faces/Jane!/` — six
  identical 357,150-byte files beside a 331,610-byte `cover.jpg`. Neither repair
  path writes suffixed names, so the writer that does is still unidentified.
- 13 tracks share a `file_path` with another row.
- One stale row: `title = 'Failed download (deezer)'`, `artist = 'Unknown Artist'`,
  no ISRC — a leftover placeholder.
- `FIFTY FIFTY — Cupid` is filed under both `The Beginning: Cupid` and
  `Cupid - Twin Ver. (Snack)`; and the `Jane!` pair is two deliberately kept
  encodes (same size 21,846,904, different md5 `b0bb9eb3…` vs `801a9885…`).
- `marked` on retry climbs 89 → 117 → 125 against rows that own audio, so some
  dead jobs still touch filed tracks.
- Some downloaded songs have no cover and no explanation.
- I once damaged three Cochise FLACs with `--remove-all-tags`; restored from the
  DB. Prefer a backup over in-place tag stripping.
