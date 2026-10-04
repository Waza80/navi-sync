import { json, unauthorizedResponse } from '$lib/server/api';
import { listFailedDownloadTracks, markDownloadStatus } from '$lib/server/db/tracks';
import { enqueueJob } from '$lib/server/queue/jobs';
import { logger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = logger;

/**
 * POST /api/tracks/retry-failed — force-retry ALL failed downloads now,
 * bypassing the 6h sweep cooldown. Each row becomes pending + gets a fresh
 * download job (priority 7, above normal queue).
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return unauthorizedResponse();
	const user = locals.user;

	const body = (await request.json().catch(() => ({}))) as { limit?: number };
	const limit = Math.min(
		200,
		Math.max(1, typeof body.limit === 'number' ? Math.floor(body.limit) : 200),
	);
	const rows = await listFailedDownloadTracks(limit);
	const jobIds: string[] = [];
	for (const row of rows) {
		const url =
			row.sourceUrl ??
			(row.provider === 'monochrome'
				? `https://tracks.monochrome.st/track/${row.providerTrackId ?? ''}`
				: `https://www.deezer.com/track/${row.providerTrackId ?? ''}`);
		const job = await enqueueJob({
			type: 'download',
			payload: {
				url,
				provider: row.provider,
				retryForTrackId: row.id,
				meta: { title: row.title, artist: row.artist },
			},
			trackId: row.id,
			priority: 7,
		});
		await markDownloadStatus(row.id, 'pending');
		jobIds.push(job.id);
	}
	log.info('failed downloads force-retried', { by: user.id, count: jobIds.length });
	return json({ requeued: jobIds.length, jobIds }, { status: 202 });
};
