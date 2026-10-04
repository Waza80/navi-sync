import { json, notFound, unauthorizedResponse } from '$lib/server/api';
import { enqueueJob } from '$lib/server/queue/jobs';
import { getTrackById } from '$lib/server/db/tracks';
import type { RequestHandler } from './$types';

/**
 * POST /api/tracks/:id/repair-metadata — force a metadata/cover repair NOW
 * (bypasses the hourly sweep). The worker fills any missing album,
 * album artist, genre, year, track number or ISRC from the catalog sources,
 * repairs broken cover art, re-tags the file and relocates it if a newly
 * discovered album changes its folder.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return unauthorizedResponse();
	const track = await getTrackById(params.id ?? '');
	if (!track) return notFound('Track not found');
	if (!track.filePath) {
		return json(
			{ ok: false, message: 'This track has no file on disk yet — nothing to repair.' },
			{ status: 400 },
		);
	}
	const job = await enqueueJob({
		type: 'metadata_repair',
		payload: { trackId: track['id'], reason: 'manual' },
		trackId: track['id'],
		createdBy: locals.user.id,
	});
	return json({ job: { id: job.id, type: job.type, status: job.status } }, { status: 202 });
};
