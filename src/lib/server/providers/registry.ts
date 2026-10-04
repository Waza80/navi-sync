import { deezerProvider } from './deezer';
import { ProviderError, type Provider } from './types';

/**
 * Ordered provider registry. Graceful degradation (spec rule 3): callers
 * traverse this list; when one provider fails the next may still serve the
 * request. Phase 1 ships one provider — the traversal seam is already in
 * place for Phase 2 multi-provider routing.
 */
export const providers: Provider[] = [deezerProvider];

export function findProviderForUrl(url: string): Provider | null {
	for (const p of providers) {
		if (p.matches(url)) return p;
	}
	return null;
}

export function getProvider(id: string): Provider {
	const p = providers.find((x) => x.id === id);
	if (!p) throw new ProviderError(`Unknown provider: ${id}`, 'PROVIDER_UNAVAILABLE');
	return p;
}

export { deezerProvider };
export type { Provider, TrackMeta, TrackRef, StreamResolution, QualityPreferences } from './types';
export { ProviderError } from './types';
