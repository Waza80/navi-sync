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
