# Lyrics

## How Navidrome 0.64.2 actually resolves lyrics

Verified by reading the shipped UI bundle and the Go source, then proven on one
library file (2026-10-21).

**The web player never asks for lyrics over the API.** The bundle (
`/app/assets/index-*.js`) contains zero references to `getLyricsBySongId`,
`lyricsList` or `structuredLyrics`. Its only lyric path is:

```js
const { lyrics: n } = song; // media_file.lyrics, the DB column
if (n)
	for (const i of JSON.parse(n))
		if (i.synced) for (const o of i.line) emit(`[mm:ss.xx] ${o.value}`);
```

So the player renders **only entries marked `synced`** from the scanned row, and
prints "No lyric" for everything else. Plain lyrics are invisible there.

That column is filled by the **scanner, from embedded tags only**. Sidecars are
read at request time by `getLyricsBySongId` (and the legacy `getLyrics`), which is
why the API can return full synced lyrics for a track whose player shows nothing.
**`getLyricsBySongId` is not evidence that a user can see the lyrics.**

### Which tag, and why timestamps must be in it

`resources/mappings.yaml` maps exactly one lyrics field:

```yaml
lyrics:
  aliases: [uslt:description, lyrics, unsyncedlyrics]
```

`LRC` is **not** an alias — a separate `LRC` tag is dropped on the floor. With the
timestamped text in `LRC` and the plain text in `LYRICS`, Navidrome indexed the
plain copy as `"synced": false`, so even the tracks that "had lyrics" showed
nothing in the player.

`model/lyrics_parse.go` falls through to `parseLRC`, and `lyrics_lrc.go` sets
`synced` from the presence of `[mm:ss.xx]` stamps. Therefore the **timestamped**
text goes in `LYRICS` itself; plain text is only the fallback when no synced form
exists. Same for MP3: the USLT frame carries the stamps.

## Measurement traps that hid this for days

- `length(lyrics) > 0` counts `[]` (two characters). The real distribution was
  **1225 rows `[]` / 84 with content**, not "584/584 have lyrics". Measure
  `lyrics <> '[]'` (or `length > 2`).
- The legacy `getLyrics` fields (`value`/`synced`) are not populated; the
  OpenSubsonic `getLyricsBySongId` endpoint is. Both read sidecars live.
- `media_file` in 0.64.2 has **no `kind` column**; prior notes about `kind: null`
  came from an older schema.

## What was broken (fixed in the lyrics rework)

1. `runLyrics` (the backfill job) wrote a sidecar and set `lyrics_status`, but
   **never embedded** into the audio file. Only the download path embedded, so the
   vast majority of the 822 tracks had a sidecar and no tag.
2. The tag writer put the plain copy in `LYRICS` and the synced copy in `LRC`
   (ignored). Even embedded lyrics were therefore `"synced": false`.
3. `ensureFileTags` re-derived every carried field except lyrics: it took the
   caller's `null` verbatim. Every retag-from-DB pass (adoption, metadata repair,
   Navidrome repair) **erased** the lyrics it was supposed to preserve.
4. Sidecars were written at a path rebuilt from tags (`<artist>/<album>/<title>`),
   not beside the audio. A merged artist credit or a renamed album stranded them
   in a directory the file never lived in (152 such files found).
5. `LRC` was written as its own tag, which nothing reads.

The fix: one `LYRICS` tag carrying the timestamps; `embedLyrics()` shared by the
download path and the lyrics job; `ensureFileTags` reads the sidecar beside the
file instead of honouring a `null`; `lyrics_embedded_at` marks rows whose tag is
written so the backfill terminates; `lyrics` sweep embeds 40 tracks per tick.

## Measured result of the rework (2026-10-21)

Before: 84 of 1309 `media_file` rows had any lyric content, and **all 84 were
`"synced": false`** — so the web player rendered lyrics for **zero** tracks while
`getLyricsBySongId` returned perfect synced lyrics for hundreds.

After the backfill (v0.12.1, 815 embedded jobs, 0 dead):

| measure                          | before |   after |
| -------------------------------- | -----: | ------: |
| Postgres rows claiming lyrics    |    822 |     815 |
| Postgres rows with tag embedded  |      0 |     815 |
| `media_file.lyrics` non-empty    |     84 |     818 |
| `media_file` with `synced: true` |      0 | **718** |

718 is the number the player can actually display. The remaining 97 are
plain-only: Navidrome drops every unsynced entry, so they stay invisible until a
synced source turns up (the sweep retries them weekly).

The 5 tracks that finished last had `lyrics_embedded_at IS NULL` with a
`succeeded` job: the embed had failed once (file mid-move), and the 24h jobs guard
then parked them. Re-enqueueing via `POST /api/lyrics/fetch/:id` fixed all five —
the guard limits retries, so a transient embed failure waits a day.

## Verifying after a deploy

```sql
-- Navidrome truth, not the API
select count(*) from media_file where lyrics <> '[]';        -- should climb to ~800
select json_extract(lyrics, '$[0].synced') from media_file
 where path like '%Fear and Trembling%';                     -- want 1
```

The UI bundle check, if the player ever regresses again:

```sh
curl -s https://navi.orbitsc.net/app/ | grep -o 'assets/index-[^"]*\.js'
# then grep that file for structuredLyrics — 0 means it still uses song.lyrics
```

Navidrome rescans on mtime change; `ND_SCANSCHEDULE=1h`. Trigger
`startScan.view` (admin) to see a backfill immediately.

## Still not built

The agreed priority spec, from before this rework:

1. Priority **word-by-word > sentence-synced > plain**.
2. Fetch periodically **until a synced lyric is found** — absence is retryable.
   (Partially built: the lyrics job now retries a plain sidecar for a synced
   version, and the 24h jobs guard caps the retry rate.)
3. The periodic sweep must **never** upgrade synced → word-by-word. Manual only.
4. Toggle `auto_upgrade_lyrics`, mirroring `auto_upgrade_quality`: off stops
   _upgrades_, missing lyrics are still fetched.
5. A manual button that does manage word-by-word.

Word-level cues are still `kind: null` / zero `cue` entries. Navidrome renders the
line-level `start` values fine, so this is cosmetic until a word-by-word source is
wired.

## Deezer LRC timestamps

Deezer omits `milliseconds`; every timestamp used to land as `[00:00.00]`. Fall
back to `lrcTimestamp`.
