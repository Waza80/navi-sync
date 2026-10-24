/**
 * Provider contract — every download platform implements this interface and is
 * registered in `registry.ts`. Adding a platform never touches job/queue code
 * (see docs/extensions.md). Reference implementations mirrored from:
 *   https://github.com/LuftVerbot/echo-deezer-extension  (Deezer method)
 */

export interface TrackRef {
	provider: string;
	/** Canonical provider-native id (e.g. Deezer SNG_ID). */
	id: string;
	sourceUrl?: string;
	/**
	 * What that id actually refers to. Defaults to 'track'.
	 *
	 * This is load-bearing: a Deezer ARTIST link resolves to an id that looks
	 * exactly like a song id, so without it the download pipeline fetched
	 * `song.getData` with an artist id and failed with "No song data" instead of
	 * recognising the link as a fan-out request.
	 */
	kind?: 'track' | 'album' | 'artist' | 'playlist';
}

export interface TrackMeta {
	provider: string;
	providerTrackId: string;
	title: string;
	artist: string;
	album: string | null;
	albumArtist: string | null;
	isrc: string | null;
	trackNumber: number | null;
	discNumber: number | null;
	durationSec: number | null;
	year: number | null;
	genre: string | null;
	/** Provider-native album id, when the provider exposes one (album fan-out). */
	albumId?: string | null;
	/** Highest-res cover art URL (jpg), if the provider exposes one. */
	coverUrl: string | null;
	sourceUrl: string | null;
	/** Provider-internal stream grant (e.g. Deezer TRACK_TOKEN). Opaque. */
	streamToken: string | null;
	/** MusicBrainz identities — filled by enrichment when available. */
	recordingMbid?: string | null;
	releaseMbid?: string | null;
	releaseGroupMbid?: string | null;
	albumArtistMbid?: string | null;
	releaseTrackMbid?: string | null;
	artistMbid?: string | null;
}

export interface QualityPreferences {
	preferLossless: boolean;
	minBitrateKbps: number;
	allowLowerFallback: boolean;
	/**
	 * Ask for hi-res masters (24-bit above CD rate) when a provider has one.
	 *
	 * Separate from `preferLossless` because the tiers are separate: a provider
	 * can have a 16/44.1 master and a 24/96 one for the same track, and refusing
	 * hi-res must still leave CD-quality lossless available. Hi-res files are
	 * roughly 3x the size of their CD counterparts, so this is a real choice
	 * rather than a free upgrade.
	 */
	preferHiRes?: boolean;
}

export interface StreamResolution {
	url: string;
	format: 'mp3' | 'flac';
	ext: 'mp3' | 'flac';
	/** Bitrate as claimed by the provider (null for lossless). */
	claimedBitrateKbps: number | null;
	claimedLossless: boolean;
	/** Bit depth as claimed (16 for standard FLAC, 24 for hires). */
	claimedBitDepth?: number | null;
	/**
	 * Sample rate as claimed, when the provider states one.
	 *
	 * Null means "the provider did not say", which is the common case: Deezer's
	 * hi-res format id is `FLAC_24` with the rate nowhere in the response. The
	 * ranker reads that as "possibly hi-res" and the downloaded file is measured
	 * immediately, so an unstated rate is never taken as fact.
	 */
	claimedSampleRateHz?: number | null;
	/** 'BF_CBC_STRIPE' → file must be decrypted locally before use. */
	cipher: 'NONE' | 'BF_CBC_STRIPE';
	/** Provider track id — required to derive the decryption key. */
	decryptTrackId: string | null;
	/**
	 * Tidal serves lossless FLAC as fragmented MP4: independent CDN objects that
	 * must be fetched and concatenated, not byte ranges of one stream. The
	 * pipeline runs the segment downloader when this is present.
	 */
	segments?: {
		initUrl: string;
		mediaUrls: string[];
		/** Size hint for progress reporting only. */
		expectedBytes?: number | null;
	};
}

export interface Provider {
	id: string;
	displayName: string;
	/**
	 * Cheap check whether this provider can handle the URL.
	 *
	 * May be async: a provider configured with an instance URL must consult its
	 * own config to know which hosts are "mine", and a shape-only match would
	 * make it claim other providers' links.
	 */
	matches(url: string): boolean | Promise<boolean>;
	/** Parse a user-supplied URL/id into a canonical ref. Null = unsupported. */
	parseRef(input: string): Promise<TrackRef | null>;
	/** Search (dashboard UI) — providers may return an empty list. */
	search(query: string): Promise<TrackMeta[]>;
	/** Optional album search + track-id listing for album fan-out. */
	searchAlbums?(query: string): Promise<
		Array<{
			provider: string;
			albumId: string;
			title: string;
			artist: string;
			year: number | null;
			coverUrl: string | null;
		}>
	>;
	albumTrackIds?(albumId: string): Promise<string[]>;
	/**
	 * Track ids of a playlist. Deezer exposes this via its gateway; the Tidal
	 * hiFi instance has no playlist endpoint at all, so a Tidal playlist URL is
	 * recognised but cannot be expanded.
	 */
	playlistTrackIds?(playlistId: string, max?: number): Promise<string[]>;
	/**
	 * Album ids for an artist, used for artist fan-out ("download everything by
	 * X"). Ordered by popularity so a fan-out starts with the well-known records.
	 */
	artistAlbumIds?(artistId: string, max?: number): Promise<string[]>;
	/** Artist search, for fan-out entry points in the UI. */
	searchArtists?(
		query: string,
	): Promise<Array<{ artistId: string; name: string; trackCount: number | null }>>;
	/**
	 * Canonicalize any provider link to {kind, id}.
	 *
	 * `artist` is part of the union because providers can recognise an artist
	 * link (and must say so) even when the caller cannot fan it out here — the
	 * artist route owns that. Returning a wrong kind makes the caller fetch an
	 * artist id as a track.
	 */
	resolveLink?(
		input: string,
	): Promise<{ kind: 'track' | 'album' | 'artist' | 'playlist'; id: string } | null>;
	/** Exact catalog lookup by ISRC — enables cross-provider best-quality. */
	findByIsrc?(isrc: string): Promise<TrackMeta | null>;
	/**
	 * ISRC lookup with the caller's album context.
	 *
	 * Optional refinement of `findByIsrc`: some catalogues reuse one ISRC across
	 * an original release and its compilations, so an album hint is what makes
	 * the match unambiguous. Providers that cannot disambiguate may omit this.
	 */
	findByIsrcInAlbum?(
		isrc: string,
		artist: string,
		title: string,
		album: string | null,
	): Promise<TrackMeta | null>;
	/** Fetch full metadata incl. stream token. */
	metadata(ref: TrackRef): Promise<TrackMeta>;
	/** Resolve a downloadable stream honoring the quality policy. */
	resolve(meta: TrackMeta, prefs: QualityPreferences): Promise<StreamResolution>;
}

export class ProviderError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'NO_CREDENTIALS'
			| 'AUTH_FAILED'
			| 'NOT_FOUND'
			| 'NO_STREAM'
			| 'QUALITY_GUARDRAIL'
			| 'RATE_LIMITED'
			| 'PROVIDER_UNAVAILABLE',
	) {
		super(message);
		this.name = 'ProviderError';
	}
}
