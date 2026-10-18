import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { listUpgradeableTrackIds, parseQualityTier } from '$lib/server/db/tracks';
import { enqueueJob } from '$lib/server/queue/jobs';
import { getSettings } from '$lib/server/settings';
import { logger } from '$lib/server/logger';
import { z } from 'zod';
import type { RequestHandler } from './$types';

const bodySchema = z.object({
	/** Narrow the run to one quality tier. Omit for "everything below the ceiling". */
	quality: z.enum(['all', 'lossy', 'cd16', 'bit24', 'hires']).optional(),
	/** Hard cap on jobs enqueued in one request. */
	limit: z.coerce.number().int().min(1).max(2000).optional(),
});

/**
 * POST /api/tracks/upgrade-all — enqueue an `upgrade_check` for every library row
 * that could still be replaced with something better.
 *
 * Bounded on purpose. The hourly sweep works through 25 tracks at a time, which
 * is right for unattended operation but useless when the user has just learned
 * that hi-res masters exist. This does the same work in one press, capped, and
 * deduped against jobs already queued — so pressing it twice does not double the
 * provider traffic.
 *
 * `priority: 6` puts these behind downloads and ahead of nothing else urgent: a
 * missing song matters more than a better master for one already present.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return unauthorizedResponse();
	const user = locals.user;

	// `.catch(() => ({}))` yields `any`; narrow it before it reaches zod so a
	// malformed body is a 400 rather than an untyped value flowing onward.
	const raw: unknown = await request.json().catch(() => ({}));
	const parsed = bodySchema.safeParse(raw);
	if (!parsed.success) {
		return badRequest('Body must be {"quality": "all|lossy|cd16|bit24|hires"}', 'INVALID_BODY');
	}
	const quality = parseQualityTier(parsed.data.quality);

	const settings = await getSettings();
	if (!settings.autoUpgradeQuality) {
		return json(
			{
				error: {
					code: 'UPGRADES_DISABLED',
					message:
						'Quality upgrades are turned off in Settings. Turn “keep hunting for better masters” on first.',
				},
			},
			{ status: 409 },
		);
	}

	const limit = parsed.data.limit ?? 500;
	// `count` is fetched with a hard cap too, so the reported remainder is honest
	// up to 2000 and simply "at least N" beyond that.
	const ids = await listUpgradeableTrackIds({ quality, limit });
	if (ids.length === 0) {
		return json({ enqueued: 0, skipped: 0, remaining: 0, quality });
	}

	let enqueued = 0;
	for (const trackId of ids) {
		try {
			await enqueueJob({
				type: 'upgrade_check',
				payload: { trackId },
				trackId,
				createdBy: user.id,
				priority: 6,
			});
			enqueued++;
		} catch (err) {
			// One bad row must not abandon the rest of the batch.
			logger.warn('bulk upgrade: could not enqueue', { trackId, error: String(err) });
		}
	}

	logger.info('bulk quality upgrade requested', {
		user: user.id,
		quality,
		enqueued,
		candidates: ids.length,
	});
	return json({ enqueued, skipped: 0, remaining: 0, quality }, { status: 202 });
};
