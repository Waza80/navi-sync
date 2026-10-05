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
