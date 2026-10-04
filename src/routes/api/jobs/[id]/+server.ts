import { json, notFound, unauthorizedResponse } from '$lib/server/api';
import { cancelJob, getJob } from '$lib/server/queue/jobs';
import type { RequestHandler } from './$types';

/** DELETE /api/jobs/:id — cancel a queued or running job. */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return unauthorizedResponse();
	const id = params.id ?? '';
	const job = await getJob(id);
	if (!job) return notFound('Job not found');
	if (!['queued', 'running'].includes(job.status)) {
		return json({
			cancelled: false,
			status: job.status,
			message: 'Job is not cancellable in its current state.',
		});
	}
	const result = await cancelJob(id);
	return json({
		cancelled: result === 'cancelled',
		cancelling: result === 'cancelling',
		status: result,
	});
};
