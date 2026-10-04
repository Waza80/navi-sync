import { json, requireUser, unauthorizedResponse } from '$lib/server/api';
import { clearCompletedJobs } from '$lib/server/queue/jobs';
import type { RequestHandler } from './$types';

/** DELETE /api/jobs/completed — bulk-clear succeeded/cancelled/failed jobs
 * ("clear unimportant parts of the queue"). Dead jobs are kept for review
 * unless explicitly retried or removed individually. */
export const DELETE: RequestHandler = async ({ locals }) => {
	if (!locals.user) return unauthorizedResponse();
	const cleared = await clearCompletedJobs();
	return json({ cleared });
};

void requireUser;
