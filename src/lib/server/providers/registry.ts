import { deezerProvider } from './deezer';
import { tidalProvider } from './tidal';
import { ProviderError, type Provider } from './types';

/**
 * Ordered provider registry. Graceful degradation (spec rule 3): callers
 * traverse this list; when one provider fails the next may still serve the
 * request. Each provider carries its own credential/config handling via the
 * Providers UI (Phase 2).
 *
 * ORDER IS PRECEDENCE. Tidal leads because it serves true lossless up to
 * 24/192 from a normal CDN, while Deezer's own catalogue tops out at 24/96 —
 * so when both are enabled and both can supply the recording, Tidal is asked
 * first. `enabledProviders()` preserves this order after filtering, so a
 * disabled provider is excluded without ever reordering the rest.
 */
export const providers: Provider[] = [tidalProvider, deezerProvider];

/**
 * First provider that claims this URL. Registry order is precedence, so the
 * first match wins — see `providers` above.
 *
 * `matches` may be async (instance-backed providers read their config), so
 * providers are probed SEQUENTIALLY: probing in parallel would let a slower
 * earlier provider lose a race it should have won on order.
 */
export async function findProviderForUrl(url: string): Promise<Provider | null> {
	for (const p of providers) {
		if (await p.matches(url)) return p;
	}
	return null;
}

export function getProvider(id: string): Provider {
	const p = providers.find((x) => x.id === id);
	if (!p) throw new ProviderError(`Unknown provider: ${id}`, 'PROVIDER_UNAVAILABLE');
	return p;
}

export { deezerProvider, tidalProvider };
export type { Provider, TrackMeta, TrackRef, StreamResolution, QualityPreferences } from './types';
export { ProviderError } from './types';
