import { z } from 'zod';
import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { listJobs } from '$lib/server/queue/jobs';
import { enqueueJob } from '$lib/server/queue/jobs';
import { getProviderConfig } from '$lib/server/providers/config';
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
			// Monochrome et al.: metadata comes from the search snapshot below.
			const cfg = await getProviderConfig<Record<string, string>>('monochrome');
			sourceUrl = `${cfg?.instanceUrl ?? 'https://tracks.monochrome.st'}/track/${parsed.data.trackId}`;
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
