# MusicBrainz and metadata

## The resolver is corroboration, not order

`src/lib/server/metadata/index.ts` collects claims from every source and resolves
each field by **agreement**: a value confirmed by ≥2 sources wins; source order
(`musicbrainz, tidal, deezer, itunes`) is only a tie-break.

This matters because each source is individually unreliable. Measured over 12
albums:

| Source      | Correct | Wrong on   |
| ----------- | ------- | ---------- |
| Tidal       | 8/12    | 3–4 albums |
| Deezer      | 7/11    | 3–4 albums |
| MusicBrainz | 6/8     | 3–4 albums |

Any two agreeing were right every time. A single-source answer is a guess, so
prefer three sources over one and never trust order alone.

`needed` tells a source which fields to fill so it can skip work (and rate
limits) when nothing is required.

## MusicBrainz specifics

- The primary `/ws/2` host is the BrainzMash mirror
  (`https://api.brainzmash.cc`, 4 req/sec), configurable via `MUSICBRAINZ_BASE_URL`.
  It 403s from both the dev host and production host `192.168.1.24` (access is
  gated case-by-case by the operator), so every request transparently falls back
  to official MusicBrainz (`https://musicbrainz.org/ws/2`, 1 req/sec) on 403/429/5xx
  or network failure. A 403 parks the mirror for a 10-minute cooldown instead of
  paying the round-trip on every call; metadata keeps working before access is
  granted and uses the faster host automatically once it is.
- All `/ws/2` requests go through a serialized per-origin rate limiter (chained
  promises) so two concurrent jobs can never both slip through the 1 req/sec limit.
- `media[].position` is the **disc** number. The real track number is the position
  of `track.recording.id` in the release's track list — and that id is the
  _recording_ MBID, not `track.id` (which is the track MBID). Fetched only when a
  number is actually wanted, because it costs a rate-limited request.
- `artist-credit[0].artist.id` is the artist MBID and
  `artist-credit[0].artist.disambiguation` is a human qualifier ("French band",
  "Electronic music producer"). Both are in the search response; the local
  `MbRecording` type only models `name`, so extract them explicitly.
- ISRC filters are broken on the instance: v1 `?isrc=` returns empty for every
  ISRC and `filter[isrc]` 400s. We ask anyway (cheap, will start working when
  Tidal repairs the index) but never trust it alone.
- ISRCs are **not unique** in Tidal: the same recording appears on its original
  album and on compilations. Always pass the album hint.
- MusicBrainz paces at roughly 1 req/s; tests that hit it live need
  `{ timeout: 30_000 }`.
- MusicBrainz is **ground truth for release facts** (album, year, track/disc
  numbers, ISRC, all MBIDs). A streaming service disagreeing with MusicBrainz about
  an album's release year is not evidence; it is the reason the value was wrong.
  Authoritative fields are taken from MusicBrainz on its own, not corroborated.

## MusicBrainz identities stored on every row

`recordingMbid`, `releaseMbid`, `releaseGroupMbid`, `albumArtistMbid`,
`releaseTrackMbid` are persisted to `tracks` (migration `0012_mbid_fields`),
written into file tags (FLAC Vorbis comments and ID3 TXXX frames under the Picard
names `MUSICBRAINZ_RECORDINGID`, `MUSICBRAINZ_ALBUMID`,
`MUSICBRAINZ_RELEASEGROUPID`, `MUSICBRAINZ_ALBUMARTISTID`,
`MUSICBRAINZ_RELEASETRACKID`, `MUSICBRAINZ_TRACKID`), read back from embedded tags
by `filetags`, included in `MetadataField`/`MetadataPatch`, asked for by
`neededFieldsFor` when missing, and exposed on `TrackDTO` for UI display. They
cannot be re-derived after a MusicBrainz merge/redirect, so they are stored on the
first resolution and never guessed.

`releaseTrackMbid` is the position-specific track id (MUSICBRAINZ_RELEASETRACKID),
distinct from `recordingMbid` (MUSICBRAINZ_TRACKID); it comes from
`media[].tracks[].id` in the release track list, not confused with the recording.

## Artist identity: names are not identities

Deezer merged two different people into artist `110750` ("Tanger"), holding all
67 albums — a French rapper and a US electronic producer. MusicBrainz separates
them: `7d90e27a…` (_Electronic music producer_, 77 release groups) and
`9ba3809e…` (_French band_, 6 release groups).

An independent signal agrees perfectly: **ISRC registrant prefix**. `FRZ…`/`FR…`
is the French registry and covers exactly the French albums; `QZ…`/`US…` is the
US registry and covers everything else. No album straddles both.

Consequences already observed:

- Same-named artists collide in one library bucket and in one Navidrome artist.
- Release years cross between them (see below).

## Known bug: release year

`provider.metadata` writes the provider's **album** `release_date` into
`meta.year`, and enrichment only fills _missing_ fields — so MusicBrainz's
release date never gets a vote. Re-running the resolver with `year: null` returns
the right year every time.

| Album                     | In DB | MusicBrainz | Deezer |
| ------------------------- | ----- | ----------- | ------ |
| La Memoire Insoluble      | 2013  | 1998        | 1998   |
| Le Detroit                | 2008  | 2000        | 2000   |
| Archive for Thought       | 2024  | 2022        | 2024   |
| Il Est Toujours 20 Heures | 2026  | 2008        | 2012   |

Some of these are genuinely ambiguous (a digital reissue has a real later date),
but 2013 for a 1998 album is not defensible.

## Cover art

`src/lib/server/metadata/cover.ts`. Cover Art Archive first — it resolved
CONFESSIONAL with `front=true, count=1` for a local-only release that is on no
streaming service at all. Deezer album search is a fallback only.
