import { MonochromeClient, type MonochromeConfig, type MonochromeTrack } from './client';
import { parseMonochromeInput } from './parse';
import { getProviderConfig } from '$lib/server/providers/config';
import { ProviderError, type Provider, type QualityPreferences, type StreamResolution, type TrackMeta, type TrackRef } from '$lib/server/providers/types';

/**
 * Monochrome provider — tracks.monochrome.st instance.
 * Requires the instance URL in Providers. The instance serves decrypted
 * FLAC directly; bare-id metadata is unavailable, so the dashboard always
 * enqueues from search results (metadata travels in the job payload).
 */

const MISSING_CONFIG = 'Monochrome is not configured. Add your instance URL in Providers.';

async function configOrThrow(): Promise<MonochromeConfig> {
	const cfg = await getProviderConfig<MonochromeConfig>('monochrome');
	if (!cfg?.instanceUrl) throw new ProviderError(MISSING_CONFIG, 'NO_CREDENTIALS');
	return cfg;
}

export const monochromeProvider: Provider = {
	id: 'monochrome',
	displayName: 'Monochrome (TIDAL proxy)',

	matches(url) {
		return parseMonochromeInput(url) !== null;
	},

	async parseRef(input): Promise<TrackRef | null> {
		const parsed = parseMonochromeInput(input);
		if (!parsed || parsed.kind !== 'track') return null;
		const cfg = await configOrThrow().catch(() => null);
		const sourceUrl = cfg ? `${cfg.instanceUrl.replace(/\/+$/, '')}/track/${parsed.id}` : input;
		return { provider: 'monochrome', id: parsed.id, sourceUrl };
	},

	async search(query: string): Promise<TrackMeta[]> {
		const cfg = await getProviderConfig<MonochromeConfig>('monochrome');
		if (!cfg?.instanceUrl) return []; // unconfigured → no results, not an error
		const client = new MonochromeClient(cfg);
		const items = await client.search(query);
		return items.map((item) => monochromeTrackToMeta(item, cfg.instanceUrl));
	},

	searchAlbums(_query: string): Promise<
		Array<{
			provider: string;
			albumId: string;
			title: string;
			artist: string;
			year: number | null;
			coverUrl: string | null;
		}>
	> {
		// The tracks API exposes releases via search; album fan-out arrives
		// when a release-endpoint is confirmed on the instance.
		return Promise.resolve([]);
	},

	albumTrackIds(_albumId: string): Promise<string[]> {
		return Promise.resolve([]);
	},

	metadata(_ref): Promise<TrackMeta> {
		// Bare ids have no metadata endpoint — the pipeline carries metadata
		// from the search snapshot via the job payload (handlers.ts).
		return Promise.reject(
			new ProviderError(
				'Monochrome tracks must be enqueued from search results (metadata travels with the job).',
				'NOT_FOUND'
			)
		);
	},

	async findByIsrc(isrc): Promise<TrackMeta | null> {
		const cfg = await getProviderConfig<MonochromeConfig>('monochrome');
		if (!cfg?.instanceUrl) return null;
		const client = new MonochromeClient(cfg);
		const items = await client.search(isrc);
		const exact = items.find((i) => (i.isrc ?? '').toUpperCase() === isrc.toUpperCase());
		if (!exact) return null;
		return monochromeTrackToMeta(exact, cfg.instanceUrl, isrc);
	},

	async resolve(meta, _prefs: QualityPreferences): Promise<StreamResolution> {
		const cfg = await configOrThrow();
		const client = new MonochromeClient(cfg);
		return client.resolveStream(meta.providerTrackId, _prefs);
	}
};

export { MonochromeClient, type MonochromeConfig };

/** Maps a Monochrome track to our generic TrackMeta. */
function monochromeTrackToMeta(
	track: MonochromeTrack,
	instanceBase: string,
	isrcOverride?: string
): TrackMeta {
	return {
		provider: 'monochrome',
		providerTrackId: track.id,
		title: track.title,
		artist: track.artist,
		album: track.album,
		albumArtist: track.artist,
		isrc: isrcOverride ?? track.isrc,
		trackNumber: null,
		discNumber: null,
		durationSec: track.durationSec,
		year: null,
		genre: null,
		coverUrl: track.artworkUrl,
		sourceUrl: `${instanceBase.replace(/\/+$/, '')}/track/${track.id}`,
		streamToken: null
	};
}
