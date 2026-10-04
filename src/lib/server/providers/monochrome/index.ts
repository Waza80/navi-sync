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

	async search(): Promise<TrackMeta[]> {
		// Monochrome exposes search through its own UI; catalog search arrives
		// with the Phase-2 batch work. Unconfigured instances search to empty.
		if (!(await getProviderConfig<MonochromeConfig>('monochrome'))) return [];
		return [];
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
