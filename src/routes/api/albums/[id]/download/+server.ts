import { z } from 'zod';
import { json, badRequest, notFound, unauthorizedResponse } from '$lib/server/api';
import { enqueueJob } from '$lib/server/queue/jobs';
import { getProvider } from '$lib/server/providers/registry';
import type { RequestHandler } from './$types';

const idSchema = z.string().min(1).max(100);

/**
 * POST /api/albums/:id/download — fan-out: enqueue every track of the album
 * (provider-specific listing; the per-download guardrail still dedupes).
 */
export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return unauthorizedResponse();
	const user = locals.user;
	const albumId = params.id ?? '';
	if (!idSchema.safeParse(albumId).success) return badRequest('Invalid album id', 'INVALID_ID');

	const provider = getProvider('deezer'); // album fan-out: deezer-capable providers
	if (!provider.albumTrackIds) return notFound('Provider does not support albums');
	const trackIds = await provider.albumTrackIds(albumId);
	if (trackIds.length === 0) return notFound('Album has no tracks');

	const jobs = [];
	for (const trackId of trackIds) {
		const job = await enqueueJob({
			type: 'download',
			payload: { url: `https://www.deezer.com/track/${trackId}`, provider: provider.id },
			createdBy: user.id,
		});
		jobs.push(job.id);
	}
	return json({ enqueued: jobs.length, albumId, jobIds: jobs }, { status: 202 });
};
