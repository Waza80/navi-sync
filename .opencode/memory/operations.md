# Operations

## Access

- App: `https://navis.orbitsc.net` — health reports `db: true` and `uptimeSec`,
  which is how you detect a deploy.
- Navidrome: `https://navi.orbitsc.net`.
- **The music library lives at `/mnt/hdd/music` on `192.168.1.16`, NOT on this host.**
  Reach it with `ssh wyzz@192.168.1.16`. Anything that touches library _files_ —
  deleting duplicates, repairing tags, checking what is actually on disk — has to run
  over there; the app container sees it as `/music`. Do not conclude a file is
  missing from an empty local `/mnt/hdd/music`: the mount simply is not present here.
  Verify with `ssh wyzz@192.168.1.16 'ls /mnt/hdd/music'` before concluding anything
  about library contents.
- Production DB: `postgres://…@192.168.1.16:3593/navisync`, read from
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

-- why jobs died
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
`APP_SECRET`.

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
