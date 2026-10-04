import { z } from 'zod';
import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { listJobs } from '$lib/server/queue/jobs';
import { enqueueJob } from '$lib/server/queue/jobs';
import type { RequestHandler } from './$types';

const listSchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(30),
});

/** GET /api/jobs?limit=30 */
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) return unauthorizedResponse();
	const parsed = listSchema.safeParse(Object.fromEntries(url.searchParams));
	const limit = parsed.success ? parsed.data.limit : 30;
	const jobs = await listJobs(limit);
	return json({
		jobs: jobs.map((j) => ({
			id: j.id,
			type: j.type,
			status: j.status,
			priority: j.priority,
			progress: j.progress,
			stage: j.stage,
			error: j.error,
			attempts: j.attempts,
			maxAttempts: j.maxAttempts,
			trackId: j.trackId,
			createdAt: j.createdAt,
			finishedAt: j.finishedAt,
		})),
	});
};

const enqueueSchema = z.object({
	url: z.string().min(1).max(2048),
});

/** POST /api/jobs — enqueue a download (alias of POST /api/tracks). */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return unauthorizedResponse();
	const user = locals.user;
	const parsed = enqueueSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return badRequest('Body must be {"url": "<provider track url>"}', 'INVALID_BODY');

	const { findProviderForUrl, getProvider, providers } =
		await import('$lib/server/providers/registry');
	const input = parsed.data.url.trim();
	const byUrl = findProviderForUrl(input);
	const providerId =
		byUrl?.id ?? (/^\d{4,15}$/.test(input) && providers.length > 0 ? providers[0].id : null);
	if (!providerId) {
		return badRequest(
			'Unsupported URL. Example: https://www.deezer.com/track/3135556',
			'UNSUPPORTED_URL',
		);
	}
	const provider = getProvider(providerId);
	const ref = await provider.parseRef(input);
	if (!ref)
		return badRequest(
			`Could not parse a ${provider.displayName} track from that URL.`,
			'INVALID_URL',
		);

	const job = await enqueueJob({
		type: 'download',
		payload: { url: ref.sourceUrl ?? input, provider: providerId },
		createdBy: user.id,
	});
	return json({ job: { id: job.id, type: job.type, status: job.status } }, { status: 201 });
};
