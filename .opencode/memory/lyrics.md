# Lyrics

## State: tags are embedded, Navidrome still reports nothing

The download pipeline writes a sidecar **and** embeds into the file:

- descriptor-less USLT frame carries synced lyrics — that alias is what Navidrome
  reads;
- plain lyrics go in when no timestamps exist.

Navidrome v0.64.2 (`openSubsonic: true`, no plugins, no `ND_LYRICSPRIORITY`) has
`media_file.lyrics` **non-empty for 584/584** rows, in OpenSubsonic v2 structured
form `[{"lang":"xxx","line":[{"value":…}]}]`.

But: `kind` is `null`, `lang` is `xxx` for every row, and **0 rows contain a
word-level `cue`**.

An earlier "0 lyrics" report here was a measurement error — it read the legacy
`getLyrics` `value`/`synced` fields, which Navidrome does not populate. Verify
against its SQLite DB, not the Subsonic API.

So lyrics are present and parseable; what is unproven is _why_ Navidrome
classifies our LRC as `kind: null` with no cues. Default `LyricsPriority` is
`".ttml,.yaml,.yml,.elrc,.lrc,.srt,.txt,embedded"` with no override, so sidecars
and embedded tags are both in scope. Start from the Navidrome DB as the lens.

## Not yet built

The agreed spec, still unimplemented:

1. Priority **word-by-word > sentence-synced > plain**.
2. Fetch periodically **until a synced lyric is found** — absence is retryable.
3. The periodic sweep must **never** upgrade synced → word-by-word. That is a
   manual button only.
4. Toggle `auto_upgrade_lyrics`, mirroring `auto_upgrade_quality` semantics: off
   stops _upgrades_, missing lyrics are still fetched.
5. A manual button that does manage word-by-word.

## Deezer LRC timestamps

Deezer omits `milliseconds`; every timestamp used to land as `[00:00.00]`. Fall
back to `lrcTimestamp`.
