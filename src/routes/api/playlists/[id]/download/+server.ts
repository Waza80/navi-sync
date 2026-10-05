import { z } from 'zod';
import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { enqueueJob } from '$lib/server/queue/jobs';
import { providers } from '$lib/server/providers/registry';
import { enabledProviders } from '$lib/server/providers/enabled';
import { trackPageUrl } from '$lib/server/providers/ids';
import { logger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = logger;
const idSchema = z.string().min(1).max(100);

/**
 * POST /api/playlists/:id/download — fan out every track of a playlist.
 *
 * Playlist ids are provider-scoped, so `?provider=` names the owner. The Tidal
 * hiFi instance exposes no playlist endpoint, so a Tidal playlist URL is
 * recognised for reference but cannot be expanded — that is reported as a clear
 * 409 rather than a silent no-op.
 */
export const POST: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) return unauthorizedResponse();
	const playlistId = params.id ?? '';
	if (!idSchema.safeParse(playlistId).success) {
		return badRequest('Invalid playlist id', 'INVALID_ID');
	}

	const maxTracks = Math.min(
		2000,
		Math.max(1, Number(url.searchParams.get('maxTracks') ?? 1000) || 1000),
	);
	const preferred = url.searchParams.get('provider') ?? undefined;

	const enabled = new Set((await enabledProviders()).map((p) => p.id));
	const candidates = providers.filter(
		(p) => enabled.has(p.id) && typeof p.playlistTrackIds === 'function',
	);
	const provider =
		(preferred ? candidates.find((p) => p.id === preferred) : null) ?? candidates[0];
	if (!provider?.playlistTrackIds) {
		return json(
			{
				error: {
					code: 'NO_PLAYLIST_PROVIDER',
					message:
						'No enabled provider can expand a playlist. Deezer supports playlist fan-out; the Tidal instance has no playlist endpoint.',
				},
			},
			{ status: 409 },
		);
	}

	let trackIds: string[];
	try {
		trackIds = await provider.playlistTrackIds(playlistId, maxTracks);
	} catch (err) {
		log.warn('playlist listing failed', {
			provider: provider.id,
			playlistId,
			error: String(err),
		});
		return json(
			{ error: { code: 'PLAYLIST_LOOKUP_FAILED', message: String(err).slice(0, 200) } },
			{ status: 502 },
		);
	}
	if (trackIds.length === 0) {
		return json(
			{
				error: {
					code: 'EMPTY_PLAYLIST',
					message: `${provider.displayName} returned no tracks.`,
				},
			},
			{ status: 404 },
		);
	}

	const jobIds: string[] = [];
	for (const trackId of trackIds.slice(0, maxTracks)) {
		const job = await enqueueJob({
			type: 'download',
			payload: {
				url: trackPageUrl(provider.id, trackId) ?? trackId,
				provider: provider.id,
			},
			createdBy: locals.user.id,
		});
		jobIds.push(job.id);
	}

	log.info('playlist fan-out enqueued', {
		provider: provider.id,
		playlistId,
		tracks: jobIds.length,
	});
	return json(
		{
			enqueued: jobIds.length,
			playlistId,
			provider: provider.id,
			truncated: trackIds.length > maxTracks,
			jobIds,
		},
		{ status: 202 },
	);
};
