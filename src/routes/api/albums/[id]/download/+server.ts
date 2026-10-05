import { z } from 'zod';
import { json, badRequest, notFound, unauthorizedResponse } from '$lib/server/api';
import { enqueueJob } from '$lib/server/queue/jobs';
import { providers } from '$lib/server/providers/registry';
import { trackPageUrl } from '$lib/server/providers/ids';
import { enabledProviders } from '$lib/server/providers/enabled';
import { logger } from '$lib/server/logger';
import type { Provider } from '$lib/server/providers/types';
import type { RequestHandler } from './$types';

const log = logger;
const idSchema = z.string().min(1).max(100);

/**
 * Resolve which enabled provider owns this album id.
 *
 * This used to be `getProvider('deezer')`, hardcoded — which meant an album found
 * through Tidal was fanned out as Deezer URLs, and with Deezer disabled the whole
 * request blew up with an unhandled rejection (HTTP 500) instead of a useful
 * error. Album ids are provider-scoped, so the caller states which provider the id
 * came from; failing that, every enabled album-capable provider is tried.
 */
async function resolveAlbumProvider(preferred?: string): Promise<Provider | null> {
	const enabled = new Set((await enabledProviders()).map((p) => p.id));
	// Bound as a local so the unbound-method lint is satisfied and the intent
	// (enabled AND album-capable) is explicit.
	const usable = providers.filter(
		(p) => enabled.has(p.id) && typeof p.albumTrackIds === 'function',
	);
	if (preferred) {
		const hit = usable.find((p) => p.id === preferred);
		if (hit) return hit;
	}
	return usable[0] ?? null;
}

/**
 * Enqueue one download per track id.
 *
 * The job payload carries the OWNING provider and a provider-native URL built
 * from that provider's own page shape, so the worker's own routing agrees with
 * what we enqueued instead of having to re-derive it.
 */
async function enqueueTracks(
	provider: Provider,
	trackIds: string[],
	userId: string,
	urlFor: (trackId: string) => string,
): Promise<string[]> {
	const jobs: string[] = [];
	for (const trackId of trackIds) {
		const job = await enqueueJob({
			type: 'download',
			payload: { url: urlFor(trackId), provider: provider.id },
			createdBy: userId,
		});
		jobs.push(job.id);
	}
	return jobs;
}

/**
 * POST /api/albums/:id/download — fan out every track of an album.
 *
 * `?provider=tidal|deezer` scopes the id; without it, enabled album-capable
 * providers are tried in registry order.
 */
export const POST: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) return unauthorizedResponse();
	const albumId = params.id ?? '';
	if (!idSchema.safeParse(albumId).success) return badRequest('Invalid album id', 'INVALID_ID');

	const preferred = url.searchParams.get('provider') ?? undefined;
	const provider = await resolveAlbumProvider(preferred);
	if (!provider?.albumTrackIds) {
		return notFound('No enabled provider supports album downloads.');
	}

	let trackIds: string[];
	try {
		trackIds = await provider.albumTrackIds(albumId);
	} catch (err) {
		log.warn('album fan-out listing failed', {
			provider: provider.id,
			albumId,
			error: String(err),
		});
		return json(
			{
				error: {
					code: 'ALBUM_LOOKUP_FAILED',
					message: `${provider.displayName} could not list that album: ${String(err).slice(0, 160)}`,
				},
			},
			{ status: 502 },
		);
	}
	if (trackIds.length === 0)
		return notFound(`${provider.displayName} returned no tracks for that album.`);

	try {
		const jobs = await enqueueTracks(
			provider,
			trackIds,
			locals.user.id,
			(trackId) => trackPageUrl(provider.id, trackId) ?? trackId,
		);
		log.info('album fan-out enqueued', { provider: provider.id, albumId, tracks: jobs.length });
		return json(
			{ enqueued: jobs.length, albumId, provider: provider.id, jobIds: jobs },
			{ status: 202 },
		);
	} catch (err) {
		log.error('album fan-out enqueue failed', {
			provider: provider.id,
			albumId,
			error: String(err),
		});
		return json(
			{ error: { code: 'ENQUEUE_FAILED', message: String(err).slice(0, 200) } },
			{ status: 500 },
		);
	}
};
