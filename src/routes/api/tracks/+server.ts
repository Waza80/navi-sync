import { z } from 'zod';
import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { listTracks } from '$lib/server/db/tracks';
import { enqueueJob } from '$lib/server/queue/jobs';
import { findProviderForUrl, getProvider, providers } from '$lib/server/providers/registry';
import { isProviderEnabled } from '$lib/server/providers/enabled';
import type { RequestHandler } from './$types';

/** GET /api/tracks?q=&page=&pageSize= — paginated, filtered track listing. */
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) return unauthorizedResponse();
	const q = url.searchParams.get('q') ?? undefined;
	const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
	const pageSize = Number.parseInt(url.searchParams.get('pageSize') ?? '50', 10);
	const result = await listTracks({
		q: q && q.trim().length > 0 ? q.trim() : undefined,
		page: Number.isFinite(page) ? page : 1,
		pageSize: Number.isFinite(pageSize) ? pageSize : 50,
	});
	return json(result);
};

const createJobSchema = z.object({
	url: z.string().min(1).max(2048),
});

/** POST /api/tracks — enqueue a download from a provider URL (or bare id). */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return unauthorizedResponse();
	const user = locals.user;

	const parsed = createJobSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return badRequest('Body must be {"url": "<provider track url>"}', 'INVALID_BODY');
	}
	const input = parsed.data.url.trim();

	// Validate routability BEFORE enqueueing (fail fast, actionable errors).
	let providerId: string;
	const byUrl = findProviderForUrl(input);
	const bareId = /^\d{4,15}$/.test(input) && providers.length > 0;
	if (byUrl) {
		providerId = byUrl.id;
	} else if (bareId) {
		// Bare provider ids are accepted when exactly one provider is configured.
		providerId = providers[0].id;
	} else {
		return badRequest(
			'Unsupported URL. Example: https://www.deezer.com/track/3135556',
			'UNSUPPORTED_URL',
		);
	}
	if (!(await isProviderEnabled(providerId))) {
		return json(
			{
				error: {
					code: 'PROVIDER_DISABLED',
					message: `${getProvider(providerId).displayName} is disabled — enable it in Settings → Providers.`,
				},
			},
			{ status: 409 },
		);
	}
	const provider = getProvider(providerId);

	// Album / playlist links fan out into one download job per track.
	if (provider.resolveLink) {
		const link = await provider.resolveLink(input).catch(() => null);
		if (link && link.kind !== 'track') {
			const ids =
				link.kind === 'album'
					? await provider.albumTrackIds?.(link.id)
					: await provider.playlistTrackIds?.(link.id, 300);
			if (!ids || ids.length === 0) {
				return badRequest(
					`That ${link.kind} resolved but contains no downloadable tracks.`,
					'EMPTY_COLLECTION',
				);
			}
			const jobIds: string[] = [];
			for (const trackId of ids) {
				const job = await enqueueJob({
					type: 'download',
					payload: {
						url: `https://www.deezer.com/track/${trackId}`,
						provider: providerId,
					},
					createdBy: user.id,
				});
				jobIds.push(job.id);
			}
			return json({ kind: link.kind, enqueued: jobIds.length, jobIds }, { status: 202 });
		}
	}

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
