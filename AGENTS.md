# navi-sync

Self-hosted music downloader. Ingests tracks/albums/artists/playlists from streaming
providers, downloads lossless audio, tags it, files it into a library, enriches
metadata, fetches lyrics, and scans into Navidrome.

Read these before touching anything — they record decisions that are expensive to
rediscover the hard way.

| File                                       | Covers                                                  |
| ------------------------------------------ | ------------------------------------------------------- |
| `.opencode/memory/architecture.md`         | Providers, queue, job lifecycle, DB, routes             |
| `.opencode/memory/musicbrainz-metadata.md` | Corroboration resolver, artist identity, source quirks  |
| `.opencode/memory/lyrics.md`               | Navidrome findings and the unbuilt lyrics priority work |
| `.opencode/memory/operations.md`           | Production access, deploy rule, verification recipes    |
| `.opencode/memory/gotchas.md`              | Traps that have each cost a debugging session           |

## Gates

Never commit until all of these pass:

```sh
bun run format && bun run check && bun run lint && bun run test && bun run build
```

`bun run format` fails on 9 `.svelte` files with `getVisitorKeys is not a function`
(prettier 3.9.9 vs svelte plugin 3.5.2). **This is pre-existing on a clean HEAD** —
verify with `git stash && bun run format` before believing you broke it. Check changed
`.ts`/`.css` files with `bunx prettier --check <files>` instead.

## Hard rules

- **Never deploy through the Coolify API.** A webhook deploys new commits.
  Push and wait for `/api/health` uptime to reset.
- **No secrets in tracked files.** `.env`, `docker/compose.prod.yaml`,
  `opencode.jsonc` are gitignored. Scrub the diff for `postgres://` and API keys
  before committing.
- **Commit and push only when explicitly asked.**
- Tidal takes precedence over Deezer; registry order _is_ the precedence order.

## Destructive operations

Never run a bulk write without all four: assert the probe's output before acting,
run inside a transaction, roll back on any count mismatch, and know the exact
expected count in advance. Reconcile logic lives in the pure, heavily-tested
`src/lib/server/library/reconcile.ts`; `scripts/reconcile-library.ts` is a thin
shell that adopts and verifies BEFORE deleting anything. See
`.opencode/memory/recovery.md` — this is not theoretical.

## Verifying a fix

Prefer measuring over asserting. Most bugs here have been "the code is right, the
provider is wrong" or the reverse, and guessing wastes hours.

- Live provider checks: throwaway scripts in `/tmp/opencode` importing from
  `src/lib/server/providers/registry`.
- Library truth: the **production Postgres**, not the Subsonic API. Direct
  connections from the dev host are flaky (ECONNREFUSED) — retry in a loop.
- Navidrome truth: its SQLite DB (`media_file.lyrics`, `media_file.kind`,
  `media_file.missing`), because the Subsonic API's legacy `getLyrics` fields are
  not populated and will make a working feature look broken.
- Deleting files behind Navidrome's back leaves ghosts it will never purge — a
  full scan only sets `media_file.missing = 1`, which is what greys the row. Clear
  them in the Navidrome UI after any bulk delete.
