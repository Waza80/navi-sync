import { providers, type Provider } from '$lib/server/providers/registry';
import { getSettings } from '$lib/server/settings';

/**
 * Registry filtered by the user's enable toggles (Settings → Providers).
 * Every consumer (search, fan-out, upgrade sweeps, direct enqueues) MUST go
 * through this instead of the raw registry so a disabled provider is fully
 * excluded from the engine.
 */
export async function enabledProviders(): Promise<Provider[]> {
	const settings = await getSettings();
	const enabled = new Set(settings.enabledProviders);
	return providers.filter((p) => enabled.has(p.id));
}

export async function isProviderEnabled(id: string): Promise<boolean> {
	const settings = await getSettings();
	return settings.enabledProviders.includes(id);
}
