# Gotchas

Each of these has cost a session. They are not stylistic preferences.

## Postgres `SUBSTRING` with a capture group

```sql
-- WRONG: no capture group, so Postgres returns the WHOLE match
substring(x from '^.*/music/')
-- RIGHT
substring(x from '^.*/music/(.*)$')
```

Hit twice. Silent, and it looks like a path bug.

## Unlayered CSS beats `@layer utilities`

`@layer utilities` has the lowest priority of all, so a plain
`.m3-icon-button { background-color: transparent }` outside any layer overrides
`bg-primary` no matter the specificity. Component classes must live in
`@layer components`. This is why the play button was invisible.

## `node-id3` dereferences _present_ keys

Passing `synchronisedLyrics: undefined` made node-id3 dereference an upstream typo
(`'lycics.language'`) and throw, which killed the entire tag write — untagged MP3s.
Filter undefined keys out before calling it. Same class of bug: any key present
in the object gets used, however meaningless its value.

## Prettier / svelte plugin mismatch

`bun run format` fails on 9 `.svelte` files with `getVisitorKeys is not a function`
(prettier 3.9.9 vs plugin 3.5.2). Pre-existing on clean HEAD. Verify with
`git stash` before blaming your change.

## Svelte `$state` is not narrowed by `{#if}`

Re-reading `nullableState` inside a handler inside the block re-widens it to
`null`. Hoist with `{@const link = pastedLink}`. And a handler that mutates state
Svelte still has to flush must `await tick()` first — `queueMicrotask` runs before
the `{#if}` block exists.

## Pasting a link is not a search query

`/api/search` must classify a pasted URL _before_ searching. Forwarding a Deezer
artist link to every provider's text search is why it appeared to be unparseable.

## Making `parseRef` succeed is not the same as routing correctly

Adding album/artist recognition made artist links resolve — and a Deezer artist id
is shaped exactly like a song id, so the pipeline then called `song.getData` with
it and reported a gateway fault. When loosening a parser, check that every caller
downstream can tell the kinds apart.

## Album-wide failure means rights, not flakiness

Every track on an album failing together is a provider rights/tier block. Scattered
failures within one album are something else. Check `readable: true` in the public
API before concluding the track is gone.

## An id is not a fact

Verifying that `parseRef` returned an id is not verifying the download works. Check
the stage that actually fails, end to end, and predict the outcome before shipping
so the prediction can be falsified.

## ext4 limits and UTF-8

Zalgo and CJK must be preserved, but paths must still respect the 255-byte limit —
measure bytes, not characters. UTF-8 corruption came from writing with a lossy
encoding, not from the text itself.

## navi-sync deployment

A webhook deploys `main`. Do not deploy through the Coolify API.

## A batch endpoint you cannot safely loop is a trap

The reindex sweep enqueues one batch per POST. I called it in a loop twice and
both times it ran away — 4000 jobs, then 8000 jobs, for a 686-track library.

Two independent causes, and the second is the one to remember:

1. `freshnessHours: 0` means "no freshness filter", which removed the last guard.
   The endpoint behaved as documented; the caller did not.
2. `tracksWithPendingJob` deduped on `jobs.track_id`, but `enqueueJob` was never
   passed a `trackId`, so every job landed with NULL and the guard matched
   nothing. Only **171 of 686** tracks were ever refreshed while the queue burned
   through 8000 duplicates.

`refreshed` sat pinned at 171 for 30 straight minutes. I watched each round
report "enqueued 100" and read that as progress. It was not — the assertion that
catches this is that `refreshed` must ADVANCE, and a loop that watches its own
progress metric should abort when it does not.

Rules that follow: any bulk endpoint needs a real idempotency key, the caller
must assert forward progress, and a dedupe guard that depends on a column has to
be verified against the data actually being written — not against intent.
