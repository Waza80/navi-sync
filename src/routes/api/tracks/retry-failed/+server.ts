import { json, unauthorizedResponse } from '$lib/server/api';
import {
	getTrackById,
	listFailedDownloadTracks,
	markDownloadStatus,
	reconcileDeadJobs,
} from '$lib/server/db/tracks';
import { enqueueJob } from '$lib/server/queue/jobs';
import { trackPageUrl } from '$lib/server/providers/ids';
import { logger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = logger;

/**
 * POST /api/tracks/retry-failed — force-retry ALL failed downloads now.
 * First reconciles: dead jobs without a failed row get one materialized
 * (and stale completed rows whose file is gone are re-marked), then every
 * failed row is requeued immediately — no cooldown, the user asked now.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return unauthorizedResponse();
	const user = locals.user;

	const body = (await request.json().catch(() => ({}))) as { limit?: number };
	const limit = Math.min(
		200,
		Math.max(1, typeof body.limit === 'number' ? Math.floor(body.limit) : 200),
	);
	const { materialized, marked } = await reconcileDeadJobs(limit);
	const rows = await listFailedDownloadTracks(limit, { ignoreCooldown: true });
	const { findBestUpgrade } = await import('$lib/server/queue/upgrades');
	const jobIds: string[] = [];
	let skipped = 0;
	for (const row of rows) {
		const full = await getTrackById(row.id);
		if (!full) {
			skipped++;
			continue;
		}
		// Hunt the best version across EVERY enabled provider (Deezer AND
		// Monochrome) — one up takes precedence, both up means best wins.
		const upgrade = await findBestUpgrade(
			{
				id: full.id,
				provider: full.provider,
				providerTrackId: full.providerTrackId,
				title: full.title,
				artist: full.artist,
				album: full.album,
				isrc: full.isrc,
				sourceUrl: full.sourceUrl,
				durationSec: full.durationSec,
				year: full.releaseYear,
				genre: full.genre,
				format: full.format,
				bitrateKbps: full.bitrateKbps,
				bitDepth: full.bitDepth,
				isLossless: full.isLossless,
			},
			{ skipRecentCheck: true },
		).catch(() => null);
		if (!upgrade) {
			// No strictly-better offer anywhere — requeue on the original
			// provider as a plain retry (transient errors may have cleared).
			const url = row.sourceUrl ?? trackPageUrl(row.provider, row.providerTrackId);
			if (!url) {
				skipped++;
				continue;
			}
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
			continue;
		}
		const job = await enqueueJob({
			type: 'download',
			payload: {
				url: upgrade.meta.sourceUrl ?? upgrade.meta.providerTrackId,
				provider: upgrade.provider,
				upgradeForTrackId: row.id,
				meta: {
					title: upgrade.meta.title,
					artist: upgrade.meta.artist,
					album: upgrade.meta.album,
					durationSec: upgrade.meta.durationSec,
					isrc: upgrade.meta.isrc,
					coverUrl: upgrade.meta.coverUrl,
					year: upgrade.meta.year,
				},
			},
			trackId: row.id,
			priority: 7,
		});
		await markDownloadStatus(row.id, 'pending');
		jobIds.push(job.id);
	}
	log.info('failed downloads force-retried', {
		by: user.id,
		materialized,
		marked,
		requeued: jobIds.length,
		skipped,
	});
	return json(
		{ materialized, marked, requeued: jobIds.length, skipped, jobIds },
		{ status: 202 },
	);
};
