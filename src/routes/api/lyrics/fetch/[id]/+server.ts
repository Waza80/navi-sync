import { json, notFound, unauthorizedResponse } from '$lib/server/api';
import { getTrackById } from '$lib/server/db/tracks';
import { enqueueJob } from '$lib/server/queue/jobs';
import type { RequestHandler } from './$types';

/** POST /api/lyrics/fetch/:id — manual lyrics fetch for a track (queued job). */
export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return unauthorizedResponse();
	const user = locals.user;
	const id = params.id ?? '';
	const track = await getTrackById(id);
	if (!track) return notFound('Track not found');
	const job = await enqueueJob({
		type: 'lyrics',
		payload: { trackId: id },
		trackId: id,
		createdBy: user.id,
	});
	return json({ job: { id: job.id, type: job.type, status: job.status } }, { status: 202 });
};
