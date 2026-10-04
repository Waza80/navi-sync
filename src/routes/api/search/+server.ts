import { z } from 'zod';
import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { enabledProviders } from '$lib/server/providers/enabled';
import type { TrackMeta } from '$lib/server/providers/types';
import type { RequestHandler } from './$types';

const searchSchema = z.object({ q: z.string().min(2).max(200) });

/**
 * GET /api/search?q= — fans out to every provider with search capability and
 * merges results (provider-tagged) for the dashboard search UI.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) return unauthorizedResponse();
	const parsed = searchSchema.safeParse({ q: url.searchParams.get('q') ?? '' });
	if (!parsed.success) return badRequest('Query must be 2-200 characters.', 'INVALID_QUERY');

	const providers = await enabledProviders();
	const [trackLists, albumLists] = await Promise.all([
		Promise.all(
			providers.map(async (p) => {
				try {
					const metas: TrackMeta[] = await p.search(parsed.data.q);
					return metas.map((m) => ({
						provider: p.id,
						providerTrackId: m.providerTrackId,
						title: m.title,
						artist: m.artist,
						album: m.album,
						durationSec: m.durationSec,
						sourceUrl: m.sourceUrl,
					}));
				} catch {
					return [];
				}
			}),
		),
		Promise.all(
			providers.map(async (p) => {
				if (!p.searchAlbums) return [];
				try {
					return await p.searchAlbums(parsed.data.q);
				} catch {
					return [];
				}
			}),
		),
	]);
	return json({ results: trackLists.flat(), albums: albumLists.flat() });
};
