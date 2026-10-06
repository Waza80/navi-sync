import { z } from 'zod';
import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { listReindexCandidates, metadataReindexSummary } from '$lib/server/db/tracks';
import { enqueueJob, tracksWithPendingJob } from '$lib/server/queue/jobs';
import { logger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = logger;

const METADATA_FIELDS = [
	'album',
	'albumArtist',
	'coverUrl',
	'genre',
	'year',
	'trackNumber',
	'discNumber',
	'isrc',
	'artistMbid',
] as const;

const bodySchema = z.object({
	/** Rows to enqueue this call. The sweep loops until nothing is left. */
	batch: z.number().int().min(1).max(500).default(100),
	/**
	 * Stop re-touching rows refreshed within this window. Without it a re-run
	 * would immediately re-enqueue everything it just did.
	 */
	freshnessHours: z.number().int().min(0).max(8760).default(24),
	/** Only these artists, for a targeted pass. */
	artist: z.string().min(1).max(200).optional(),
	/**
	 * Re-ask for these fields ONLY, even where they are already filled.
	 *
	 * This exists because `force` re-asks for everything, which is right once and
	 * wasteful forever. Genre was the case that needed it: empty on every row because
	 * no source implemented it, then implemented — but rows already verified in an
	 * earlier pass were never revisited, since a field is only requested while it is
	 * missing. `fields: ['genre']` is one cheap request per track and touches nothing
	 * else.
	 */
	fields: z.array(z.enum(METADATA_FIELDS)).max(9).optional(),
});

/**
 * GET /api/metadata/reindex — what has been re-fetched so far.
 *
 * A reindex that changed nothing and a reindex that never ran used to look
 * identical from the dashboard, which is how a wrong release year sat unnoticed.
 * `byStatus` separates `corrected` (a filled field turned out wrong and was
 * overwritten) from `verified` (re-asked, agreed) and from rows never touched.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return unauthorizedResponse();
	return json(await metadataReindexSummary());
};

/**
 * POST /api/metadata/reindex — re-fetch metadata for every filed track.
 *
 * This is a FORCE pass, not a gap pass. Sources are re-asked for every field
 * including ones the row already has, which is the only way a filled-but-wrong
 * value can ever be corrected — the provider's album release date is written
 * into `year` at download time, and the gap-only rule then skipped it forever.
 *
 * It is deliberately slow rather than clever: MusicBrainz is the authority for
 * album, year, track number and artist identity, it is rate-limited to roughly
 * one request a second, and fifteen minutes for nine hundred songs is a price
 * worth paying for a correct index. Jobs run one at a time through the normal
 * queue with exponential backoff, so a MusicBrainz 503 or 429 retries itself
 * instead of dead-lettering the pass.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return unauthorizedResponse();
	const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
	if (!parsed.success) return badRequest('Invalid reindex options.', 'INVALID_BODY');
	const { batch, freshnessHours, artist, fields } = parsed.data;

	// Skip anything already queued or running. Timestamps alone are not enough:
	// a row's metadata_refreshed_at is only stamped when its job RUNS, so a caller
	// looping faster than the queue drains would re-enqueue the same rows forever.
	const busy = await tracksWithPendingJob('metadata_repair');
	const rows = await listReindexCandidates(batch * 4);
	const cutoff = freshnessHours === 0 ? null : Date.now() - freshnessHours * 3_600_000;
	const wanted = artist?.toLowerCase();

	const picked: string[] = [];
	for (const row of rows) {
		if (picked.length >= batch) break;
		if (busy.has(row.id)) continue;
		if (wanted && !row.artist.toLowerCase().includes(wanted)) continue;
		// Already refreshed inside the freshness window: leave it alone, or a
		// re-run would immediately re-do its own work.
		//
		// An explicit `fields` request EXEMPTS itself. The window exists to stop a
		// routine sweep re-doing its own work, but `{"fields":["coverUrl"]}` is a
		// deliberate instruction to go and get that one field, and honouring the
		// window silently returned `enqueued: 0` for rows refreshed minutes earlier
		// — which reads as "there is nothing to fetch" when in fact the fetch was
		// never attempted.
		if (!fields && cutoff && row.metadataRefreshedAt && row.metadataRefreshedAt.getTime() > cutoff)
			continue;
		picked.push(row.id);
	}

	if (picked.length === 0) {
		return json({
			enqueued: 0,
			reason: 'nothing to re-fetch',
			...(await metadataReindexSummary()),
		});
	}

	for (const trackId of picked) {
		await enqueueJob({
			type: 'metadata_repair',
			payload: {
				trackId,
				reason: fields ? `reindex:${fields.join('+')}` : 'reindex',
				force: true,
				...(fields ? { fields } : {}),
			},
			// Required, not decorative: tracksWithPendingJob dedupes on jobs.track_id,
			// so without it the reindex's own guard can never match and the sweep
			// re-enqueues the same rows forever. That shipped broken and produced
			// 8000 jobs for 171 distinct tracks.
			trackId,
			// Behind ordinary work so a reindex never starves a user's download.
			priority: -5,
			maxAttempts: 6,
		});
	}
	log.info('metadata reindex batch enqueued', { count: picked.length, artist, freshnessHours });

	return json({
		enqueued: picked.length,
		fields: fields ?? 'all',
		...(await metadataReindexSummary()),
	});
};
