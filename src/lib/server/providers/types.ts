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
	/** Highest-res cover art URL (jpg), if the provider exposes one. */
	coverUrl: string | null;
	sourceUrl: string | null;
	/** Provider-internal stream grant (e.g. Deezer TRACK_TOKEN). Opaque. */
	streamToken: string | null;
}

export interface QualityPreferences {
	preferLossless: boolean;
	minBitrateKbps: number;
	allowLowerFallback: boolean;
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
	/** 'BF_CBC_STRIPE' → file must be decrypted locally before use. */
	cipher: 'NONE' | 'BF_CBC_STRIPE';
	/** Provider track id — required to derive the decryption key. */
	decryptTrackId: string | null;
	/**
	 * Cloudflare-capped instances: the URL only serves ~512KiB/connection —
	 * the pipeline must download via parallel Range chunks.
	 */
	chunked?: boolean;
}

export interface Provider {
	id: string;
	displayName: string;
	/** Cheap sync check whether this provider can handle the URL. */
	matches(url: string): boolean;
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
	/** Canonicalize any provider link (track/album/playlist) to {kind, id}. */
	resolveLink?(
		input: string
	): Promise<{ kind: 'track' | 'album' | 'playlist'; id: string } | null>;
	/** Playlist track-id listing for playlist fan-out. */
	playlistTrackIds?(playlistId: string, max?: number): Promise<string[]>;
	/** Exact catalog lookup by ISRC — enables cross-provider best-quality. */
	findByIsrc?(isrc: string): Promise<TrackMeta | null>;
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
