import { getProviderConfig } from '$lib/server/providers/config';
import {
	ProviderError,
	type Provider,
	type QualityPreferences,
	type StreamResolution,
	type TrackMeta,
	type TrackRef,
} from '$lib/server/providers/types';
import { TidalClient, type TidalConfig, type TidalTrack } from './client';
import { instanceTrackId, parseTidalInput } from './parse';

/**
 * Tidal provider — a self-hosted `hiFi` (hifi-api) instance.
 *
 * The instance holds the Tidal account, so this provider needs no credentials:
 * one instance URL and nothing else. That is the whole reason it replaced the
 * Cloudflare-capped proxy — same "bring your own instance" shape, but a real
 * CDN at the far end instead of a throttled origin.
 *
 * Quality: resolves `HI_RES_LOSSLESS` first, so releases mastered at 24/96 or
 * 24/192 come back at their true bit depth (Tidal reports it per release, and
 * `claimedBitDepth` therefore reflects measurement rather than a guess).
 *
 * Bare-id metadata DOES work here (`/info/?id=`), so jobs may be enqueued from a
 * provider id alone rather than only from a search snapshot.
 */

const MISSING_CONFIG = 'Tidal is not configured. Add your hiFi instance URL in Providers.';

async function configOrThrow(): Promise<TidalConfig> {
	const cfg = await getProviderConfig<TidalConfig>('tidal');
	if (!cfg?.instanceUrl) throw new ProviderError(MISSING_CONFIG, 'NO_CREDENTIALS');
	return cfg;
}

async function clientOrNull(): Promise<TidalClient | null> {
	const cfg = await getProviderConfig<TidalConfig>('tidal');
	return cfg?.instanceUrl ? new TidalClient(cfg) : null;
}

export const tidalProvider: Provider = {
	id: 'tidal',
	displayName: 'Tidal (hiFi instance)',

	/**
	 * Tidal claims its own links plus those of the CONFIGURED instance.
	 *
	 * Instance URLs live on an arbitrary host, so they are matched against the
	 * configured instance URL rather than by shape — otherwise any provider's
	 * `/track/<id>` link would match here, and since Tidal is first in the
	 * registry that would silently shadow Deezer.
	 */
	async matches(url: string): Promise<boolean> {
		if (parseTidalInput(url) !== null) return true;
		const cfg = await getProviderConfig<TidalConfig>('tidal');
		return instanceTrackId(url, cfg?.instanceUrl) !== null;
	},

	async parseRef(input): Promise<TrackRef | null> {
		const cfg = await getProviderConfig<TidalConfig>('tidal');
		// Instance URLs are checked first: on the instance host the same path
		// shape would otherwise be ambiguous.
		const instanceId = instanceTrackId(input, cfg?.instanceUrl);
		const id =
			instanceId ??
			(() => {
				const parsed = parseTidalInput(input);
				return parsed?.kind === 'track' ? parsed.id : null;
			})();
		if (!id) return null;
		const base = cfg?.instanceUrl?.replace(/\/+$/, '');
		return {
			provider: 'tidal',
			id,
			sourceUrl: base
				? `${base}/track/?id=${encodeURIComponent(id)}`
				: `https://tidal.com/track/${id}`,
		};
	},

	async search(query: string): Promise<TrackMeta[]> {
		const client = await clientOrNull();
		// Unconfigured → no results rather than an error: the dashboard should
		// simply show nothing for a provider the user has not set up.
		if (!client) return [];
		const items = await client.search(query);
		return items.map((t) => tidalTrackToMeta(t));
	},

	/**
	 * Album candidates for fan-out.
	 *
	 * The instance's `/search/` returns tracks only — there is no album search —
	 * so albums are derived by grouping the track results on `album.id`. Each
	 * track already carries the album id, title, cover and release date, which is
	 * everything fan-out needs; `albumTrackIds` then lists the full tracklist.
	 */
	async searchAlbums(query: string): Promise<
		Array<{
			provider: string;
			albumId: string;
			title: string;
			artist: string;
			year: number | null;
			coverUrl: string | null;
		}>
	> {
		const client = await clientOrNull();
		if (!client) return [];
		const tracks = await client.search(query, 50);
		const seen = new Map<string, TidalTrack>();
		for (const t of tracks) {
			if (t.albumId && !seen.has(t.albumId)) seen.set(t.albumId, t);
		}
		return [...seen.values()].map((t) => ({
			provider: 'tidal',
			albumId: t.albumId ?? '',
			title: t.album ?? t.title,
			artist: t.albumArtist ?? t.artist,
			year: t.year,
			coverUrl: t.artworkUrl,
		}));
	},

	async albumTrackIds(albumId: string): Promise<string[]> {
		const client = await clientOrNull();
		if (!client) return [];
		const tracks = await client.albumTracks(albumId);
		return tracks.map((t) => t.id);
	},

	// Synchronous by nature: parsing is pure. Returns a promise to satisfy the
	// Provider interface without pretending there is I/O to await.
	resolveLink(input): Promise<{
		kind: 'track' | 'album' | 'playlist';
		id: string;
	} | null> {
		const parsed = parseTidalInput(input);
		if (parsed?.kind === undefined) return Promise.resolve(null);
		// The engine only fans out over tracks, albums and playlists.
		if (parsed.kind === 'artist') return Promise.resolve(null);
		return Promise.resolve({ kind: parsed.kind, id: parsed.id });
	},

	/**
	 * Cross-provider lookup by ISRC.
	 *
	 * The Provider signature carries only the ISRC, so artist/title are unknown
	 * here. Tidal reuses ISRCs across compilations, so an ambiguous match is
	 * reported as no match and the caller falls back to its normal
	 * title/artist/duration search rather than risking a wrong-album filing.
	 */
	async findByIsrc(isrc: string): Promise<TrackMeta | null> {
		const client = await clientOrNull();
		if (!client) return null;
		const hit = await client.findByIsrc(isrc);
		return hit ? tidalTrackToMeta(hit) : null;
	},

	/**
	 * ISRC lookup WITH the caller's album context, used by the upgrade engine.
	 *
	 * Registered separately from findByIsrc because the generic contract cannot
	 * express "same recording, this album" — which is what disambiguates the
	 * duplicate ISRCs Tidal's catalogue contains.
	 */
	async findByIsrcInAlbum(
		isrc: string,
		artist: string,
		title: string,
		album: string | null,
	): Promise<TrackMeta | null> {
		const client = await clientOrNull();
		if (!client) return null;
		const hit = await client.findByIsrc(isrc, artist, title, { album });
		return hit ? tidalTrackToMeta(hit) : null;
	},

	async metadata(ref: TrackRef): Promise<TrackMeta> {
		const client = await configOrThrow().then((cfg) => new TidalClient(cfg));
		const track = await client.track(ref.id);
		return tidalTrackToMeta(track, ref.sourceUrl ?? undefined);
	},

	async resolve(meta: TrackMeta, prefs: QualityPreferences): Promise<StreamResolution> {
		const client = await configOrThrow().then((cfg) => new TidalClient(cfg));
		return client.resolve(meta.providerTrackId, prefs);
	},
};

export { TidalClient, type TidalConfig, type TidalTrack };
export { downloadTidalFlac } from './download';

export function tidalTrackToMeta(track: TidalTrack, sourceUrl?: string): TrackMeta {
	return {
		provider: 'tidal',
		providerTrackId: track.id,
		title: track.title,
		artist: track.artist,
		album: track.album,
		albumId: track.albumId,
		albumArtist: track.albumArtist,
		isrc: track.isrc,
		trackNumber: track.trackNumber,
		discNumber: track.discNumber,
		durationSec: track.durationSec,
		year: track.year,
		genre: null,
		coverUrl: track.artworkUrl,
		sourceUrl: sourceUrl ?? track.sourceUrl,
		streamToken: null,
	};
}
