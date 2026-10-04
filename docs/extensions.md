# Extensions

How to add download providers and lyrics sources. No runtime plugin loading
(by design, v1): extensions are internal modules registered in code —
type-safe, reviewed, and testable.

Reference implementations studied for Phase 1:

- [LuftVerbot/echo-deezer-extension](https://github.com/LuftVerbot/echo-deezer-extension) — Deezer gateway/login/media method (ported)
- [shub39/echo-lrclib-extension](https://github.com/shub39/echo-lrclib-extension) — LRCLIB usage pattern (ported)
- atvalerie/monodownload — batch/CSV resolution patterns (Phase 2 reference)

## 1. Adding a download platform

### Contract — `src/lib/server/providers/types.ts`

```ts
export interface Provider {
	id: string; // stable id stored in DB rows/jobs
	displayName: string;
	matches(url: string): boolean; // cheap sync routing check
	parseRef(input: string): Promise<TrackRef | null>;
	search(query: string): Promise<TrackMeta[]>; // Phase 2 UI
	metadata(ref: TrackRef): Promise<TrackMeta>; // incl. streamToken
	resolve(meta: TrackMeta, prefs: QualityPreferences): Promise<StreamResolution>;
}
```

`StreamResolution` carries the URL plus everything the pipeline needs:
`format`, `ext`, claimed bitrate/lossless, `cipher` (`NONE` |
`BF_CBC_STRIPE`) and `decryptTrackId` when local decryption is required.

### Steps

1. Create `src/lib/server/providers/<platform>/index.ts` implementing
   `Provider` (pure helpers — URL parsing, key math — in separate files with
   unit tests; see `deezer/parse.ts`, `deezer/blowfish.ts`).
2. Register in `providers/registry.ts`:

```ts
export const providers: Provider[] = [deezerProvider, myNewProvider];
```

Routing is **graceful degradation by registry order** (spec rule 3): the
first provider whose `matches()` passes handles the request; failures
propagate as actionable `ProviderError`s with typed codes.

3. If the platform needs credentials: store a session blob encrypted via
   `provider_credentials` (mirror `deezer/gateway.ts` — never persist
   plaintext; never log secrets; the logger redacts by key name).
4. Add unit tests for parsing/quality decisions (network-free) and one E2E
   job through `scripts/smoke.sh`.

The queue, guardrails (24-bit ceiling), tagging, lyrics, library layout, SSE
and UI require **zero changes** — that's the point of the trait.

### Gotchas learned from Deezer (apply to new providers)

- Bot protection discriminates TLS fingerprints: keep a curl-subprocess
  fallback for auth endpoints (see `fetchAccessToken`).
- API response shapes drift: normalize defensively (`checkForm` vs
  `USER_TOKEN`, `sources` object vs array), and log raw failures for review.
- Never accept anonymous sessions (`USER_ID === '0'`).

## 2. Adding a lyrics source

### Contract — `src/lib/server/lyrics/types.ts`

```ts
export interface LyricsSource {
	id: string;
	displayName: string;
	fetch(q: LyricsQuery, meta?: TrackMeta): Promise<LyricsResult | null>;
	// LyricsResult = { synced: string | null; plain: string | null }
}
```

### Steps

1. Implement the source (`fetch` returns `null` when the platform has
   nothing — never throw for "not found").
2. Register in `lyricsSources` (`src/lib/server/lyrics/index.ts`) in priority
   order. Traversal: first source returning content wins; synced beats plain
   per source; sidecar written as `.lrc` (synced) or `.txt` (plain).
3. When ALL sources fail, the manager logs `ALL LYRICS SOURCES FAILED`
   loudly (spec: manual review) and marks `tracks.lyrics_status='failed'` —
   the audio file is never blocked by lyrics.

Reference: `lrclib.ts` (exact `/api/get` → `/api/search` fallback with
duration matching) and `deezer-pipe.ts` (GraphQL synchronized lines → LRC).

## 3. Future: engine extraction (Tauri/Rust)

Because jobs/progress live entirely in PostgreSQL (ADR-0002), a Rust engine
is a second consumer:

- claim: `UPDATE jobs SET status='running' … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`
- wake: `LISTEN navi_jobs`
- report: `pg_notify('navi_events', json)` with the `NaviEvent` shape from
  `src/lib/shared/types.ts` (the SSE/UI contract)
- artifacts: write into `MUSIC_LIBRARY_DIR` + upsert `tracks`

No API or UI changes required.
