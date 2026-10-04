import { json, notFound, unauthorizedResponse } from '$lib/server/api';
import { getTrackById, markDownloadStatus } from '$lib/server/db/tracks';
import { enqueueJob } from '$lib/server/queue/jobs';
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
	const url =
		track.sourceUrl ??
		(providerId === 'monochrome'
			? `https://tracks.monochrome.st/track/${String(track.providerTrackId ?? '')}`
			: `https://www.deezer.com/track/${String(track.providerTrackId ?? '')}`);
	await markDownloadStatus(track.id, 'pending');
	const job = await enqueueJob({
		type: 'download',
		payload: {
			url,
			provider: providerId,
			...(track.title
				? { meta: { title: track.title, artist: track.artist, album: track.album } }
				: {}),
			retryForTrackId: track.id
		},
		trackId: track.id,
		priority: 7
	});
	return json({ job: { id: job.id, type: job.type, status: job.status } }, { status: 202 });
};
