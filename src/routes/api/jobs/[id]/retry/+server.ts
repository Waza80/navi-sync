import { json, notFound, unauthorizedResponse } from '$lib/server/api';
import { retryJob } from '$lib/server/queue/jobs';
import type { RequestHandler } from './$types';

/** POST /api/jobs/:id/retry — manual retry of a dead/failed/cancelled job. */
export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return unauthorizedResponse();
	const id = params.id ?? '';
	const job = await retryJob(id);
	if (!job) return notFound('No retryable job with that id');
	return json({ retried: true, id: job.id, status: job.status });
};
