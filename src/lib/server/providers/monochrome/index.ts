import { MonochromeClient, toTrackMeta, type MonochromeConfig } from './client';
import { parseMonochromeInput } from './parse';
import { getProviderConfig } from '$lib/server/providers/config';
import {
	ProviderError,
	type Provider,
	type QualityPreferences,
	type StreamResolution,
	type TrackMeta,
	type TrackRef,
} from '$lib/server/providers/types';

/**
 * Monochrome provider — self-hosted TIDAL proxy instances.
 * Requires per-provider configuration (instance URL [+ Basic auth]) via the
 * Providers UI; without configuration it reports a clear NOT_CONFIGURED error.
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
		const base = cfg.instanceUrl.replace(/\/+$/, '');
		return items.map((item) => {
			const meta = toTrackMeta(item, base);
			return { ...meta, album: meta.album };
		});
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
		// Album search arrives with instance capability detection.
		return Promise.resolve([]);
	},

	albumTrackIds(_albumId: string): Promise<string[]> {
		// Album fan-out for Monochrome lands with capability detection.
		return Promise.resolve([]);
	},

	async metadata(ref) {
		const cfg = await configOrThrow();
		const client = new MonochromeClient(cfg);
		const track = await client.getTrackMetadata(ref.id);
		return toTrackMeta(track, cfg.instanceUrl.replace(/\/+$/, ''));
	},

	async resolve(meta, prefs: QualityPreferences): Promise<StreamResolution> {
		const cfg = await configOrThrow();
		const client = new MonochromeClient(cfg);
		return client.resolveStream(meta.providerTrackId, prefs);
	},
};

export { MonochromeClient, type MonochromeConfig };
