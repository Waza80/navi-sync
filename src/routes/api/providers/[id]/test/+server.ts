import { json, notFound, unauthorizedResponse } from '$lib/server/api';
import { descriptorFor } from '$lib/server/providers/descriptors';
import { getDeezerSession, clearInMemorySession } from '$lib/server/providers/deezer/gateway';
import { TidalClient } from '$lib/server/providers/tidal/client';
import { getProviderConfig } from '$lib/server/providers/config';
import type { RequestHandler } from './$types';

/**
 * POST /api/providers/:id/test — live "alive check".
 *   deezer → validates the encrypted session (auto-relogs if needed)
 *   tidal  → real catalog search probe against the instance
 */
export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return unauthorizedResponse();
	const id = params.id ?? '';
	if (!descriptorFor(id)) return notFound('Unknown provider');

	if (id === 'deezer') {
		try {
			clearInMemorySession(); // force a real round-trip, not the memory cache
			const session = await getDeezerSession();
			return json({ ok: true, detail: `Alive — signed in as user ${session.userId}` });
		} catch (err) {
			return json(
				{ ok: false, detail: err instanceof Error ? err.message : String(err) },
				{ status: 502 },
			);
		}
	}

	if (id === 'tidal') {
		const cfg = await getProviderConfig<{
			instanceUrl: string;
			quality?: 'HI_RES_LOSSLESS' | 'LOSSLESS' | 'LOW';
		}>('tidal');
		if (!cfg?.instanceUrl) {
			return json({ ok: false, detail: 'No instance URL configured.' }, { status: 400 });
		}
		const client = new TidalClient({ ...cfg, instanceUrl: cfg.instanceUrl });
		const ping = await client.ping();
		if (!ping.ok) {
			return json({ ok: false, detail: ping.detail ?? 'unreachable' }, { status: 502 });
		}
		return json({ ok: true, detail: ping.detail ?? 'Instance reachable' });
	}

	return notFound('Unknown provider');
};
