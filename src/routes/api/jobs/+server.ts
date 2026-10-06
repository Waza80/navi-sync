import { z } from 'zod';
import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { enqueueJob, jobCounts, listJobs } from '$lib/server/queue/jobs';
import type { JobStatus } from '$lib/shared/types';
import type { RequestHandler } from './$types';
import { logger as log } from '$lib/server/logger';

const ALL_STATUSES: JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'];

/**
 * GET /api/jobs?limit=30&status=queued,running
 *
 * `limit` CLAMPS rather than falling back. It previously validated as
 * `max(100)` and any out-of-range request failed the schema, so the handler
 * quietly used 30 — asking for 300 jobs and receiving 30 with no indication that
 * the parameter had been discarded. A silently ignored parameter reads as "that
 * is all there is".
 *
 * `counts` is computed over the whole table, never from the returned window, so
 * "Active 412" cannot be an artefact of a 30-row slice.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) return unauthorizedResponse();

	const rawLimit = Number(url.searchParams.get('limit') ?? 30);
	const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.trunc(rawLimit))) : 30;
	const requested = (url.searchParams.get('status') ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter((s): s is JobStatus => (ALL_STATUSES as string[]).includes(s));

	// A queue read must never take the page down.
	//
	// There was no error handling here at all, so any throw from `listJobs` or
	// `jobCounts` — a dropped connection to Postgres, a statement timeout while a
	// repair is rewriting rows — became an unhandled 500, which the reverse proxy
	// surfaced as a 502 and the dashboard rendered as a blank page. The queue is a
	// panel on the page, not the page.
	//
	// So this returns 200 with an empty queue and `degraded: true`. The UI shows
	// "queue unavailable" instead of the library vanishing, and the next poll
	// recovers on its own. Only an unauthenticated request is an error.
	let jobs: Awaited<ReturnType<typeof listJobs>> = [];
	let counts: Awaited<ReturnType<typeof jobCounts>> = { total: 0, active: 0, byStatus: {} };
	let degraded = false;
	try {
		[jobs, counts] = await Promise.all([listJobs(limit, requested), jobCounts()]);
	} catch (err) {
		degraded = true;
		log.warn('job listing failed; serving an empty queue', {
			limit,
			statusFilter: requested,
			error: String(err),
		});
	}
	return json({
		degraded,
		counts,
		limit,
		statusFilter: requested,
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
			result: j.result,
			createdAt: j.createdAt,
			finishedAt: j.finishedAt,
		})),
	});
};

const metaSchema = z.object({
	title: z.string().min(1).max(300),
	artist: z.string().min(1).max(300),
	album: z.string().max(300).nullable().optional(),
	durationSec: z.number().int().nullable().optional(),
	isrc: z.string().max(20).nullable().optional(),
	coverUrl: z.string().url().max(1000).nullable().optional(),
	year: z.number().int().nullable().optional(),
});
const enqueueSchema = z.union([
	z.object({ url: z.string().min(1).max(2048) }),
	z.object({
		provider: z.string().min(1).max(50),
		trackId: z.string().min(1).max(100),
		meta: metaSchema.optional(),
	}),
]);

/** POST /api/jobs — enqueue a download (URL or provider+trackId from search). */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return unauthorizedResponse();
	const user = locals.user;
	const parsed = enqueueSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success)
		return badRequest(
			'Body must be {"url": "..."} or {"provider": "...", "trackId": "..."}',
			'INVALID_BODY',
		);

	if ('trackId' in parsed.data) {
		// Direct enqueue from search results — metadata snapshot travels with
		// the job (required for providers without bare-id metadata lookups).
		const { getProvider } = await import('$lib/server/providers/registry');
		const { isProviderEnabled } = await import('$lib/server/providers/enabled');
		if (!(await isProviderEnabled(parsed.data.provider))) {
			return json(
				{
					error: {
						code: 'PROVIDER_DISABLED',
						message: 'That provider is disabled — enable it in Settings → Providers.',
					},
				},
				{ status: 409 },
			);
		}
		const provider = getProvider(parsed.data.provider);
		let sourceUrl = `https://www.deezer.com/track/${parsed.data.trackId}`;
		try {
			const resolved = await provider.metadata({
				provider: provider.id,
				id: parsed.data.trackId,
				sourceUrl: undefined,
			});
			sourceUrl = resolved.sourceUrl ?? sourceUrl;
		} catch {
			// Metadata unavailable (e.g. the instance is down): fall back to a
			// provider-shaped URL so the job can still be routed and retried.
			if (provider.id === 'tidal') {
				sourceUrl = `https://tidal.com/track/${parsed.data.trackId}`;
			}
		}
		const job = await enqueueJob({
			type: 'download',
			payload: {
				url: sourceUrl,
				provider: provider.id,
				...(parsed.data.meta ? { meta: parsed.data.meta } : {}),
			},
			createdBy: user.id,
		});
		return json({ job: { id: job.id, type: job.type, status: job.status } }, { status: 201 });
	}

	const { findProviderForUrl, getProvider, providers } = await import(
		'$lib/server/providers/registry'
	);
	const input = parsed.data.url.trim();
	const byUrl = await findProviderForUrl(input);
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
