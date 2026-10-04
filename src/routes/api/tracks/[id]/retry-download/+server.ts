import { json, notFound, unauthorizedResponse } from '$lib/server/api';
import { getTrackById, markDownloadStatus } from '$lib/server/db/tracks';
import { enqueueJob } from '$lib/server/queue/jobs';
import { trackPageUrl } from '$lib/server/providers/ids';
import type { RequestHandler } from './$types';

/** POST /api/tracks/:id/retry-download — re-enqueue a failed download now. */
export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return unauthorizedResponse();
	const track = await getTrackById(params.id ?? '');
	if (!track) return notFound('Track not found');
	if (track.downloadStatus !== 'failed') {
		return json({ ok: false, message: 'Track is not in a failed state.' }, { status: 400 });
	}
	const providerId = track.provider ?? 'deezer';

	// Hunt the best version across EVERY enabled provider (Deezer AND
	// Tidal) — one up takes precedence, both up means best wins.
	const { findBestUpgrade } = await import('$lib/server/queue/upgrades');
	const upgrade = await findBestUpgrade(
		{
			id: track.id,
			provider: track.provider,
			providerTrackId: track.providerTrackId,
			title: track.title,
			artist: track.artist,
			album: track.album,
			isrc: track.isrc,
			sourceUrl: track.sourceUrl,
			durationSec: track.durationSec,
			year: track.releaseYear,
			genre: track.genre,
			format: track.format,
			bitrateKbps: track.bitrateKbps,
			bitDepth: track.bitDepth,
			isLossless: track.isLossless,
		},
		{ skipRecentCheck: true },
	).catch(() => null);

	let url: string | null;
	let jobProvider = providerId;
	let retryForTrackId: string | undefined = track.id;
	let upgradeForTrackId: string | undefined;
	let meta: Record<string, unknown> = {
		title: track.title,
		artist: track.artist,
		album: track.album,
	};

	if (upgrade) {
		url = upgrade.meta.sourceUrl ?? upgrade.meta.providerTrackId;
		jobProvider = upgrade.provider;
		upgradeForTrackId = track.id;
		retryForTrackId = undefined;
		meta = {
			title: upgrade.meta.title,
			artist: upgrade.meta.artist,
			album: upgrade.meta.album,
			durationSec: upgrade.meta.durationSec,
			isrc: upgrade.meta.isrc,
			coverUrl: upgrade.meta.coverUrl,
			year: upgrade.meta.year,
		};
	} else {
		// No strictly-better offer anywhere — requeue on the original
		// provider as a plain retry (transient errors may have cleared).
		url = track.sourceUrl ?? trackPageUrl(providerId, track.providerTrackId);
	}

	if (!url) {
		return json(
			{ ok: false, message: 'No source URL available for this track.' },
			{ status: 400 },
		);
	}

	await markDownloadStatus(track.id, 'pending');
	const job = await enqueueJob({
		type: 'download',
		payload: {
			url,
			provider: jobProvider,
			...(retryForTrackId ? { retryForTrackId } : {}),
			...(upgradeForTrackId ? { upgradeForTrackId } : {}),
			meta,
		},
		trackId: track.id,
		priority: 7,
	});
	return json({ job: { id: job.id, type: job.type, status: job.status } }, { status: 202 });
};
