import { json, notFound, unauthorizedResponse } from '$lib/server/api';
import { enqueueJob } from '$lib/server/queue/jobs';
import { getTrackById } from '$lib/server/db/tracks';
import type { RequestHandler } from './$types';

/**
 * POST /api/tracks/:id/upgrade — force a quality check NOW (bypasses the
 * hourly sweep backoff). The worker re-resolves the best stream for the
 * track's provider; a strictly better offer is downloaded (and lyrics
 * refetched); otherwise the job completes with "no better version".
 */
export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return unauthorizedResponse();
	const track = await getTrackById(params.id ?? '');
	if (!track) return notFound('Track not found');
	const provider = track.provider;
	const providerTrackId = track.providerTrackId;
	if (!providerTrackId) {
		return json(
			{
				ok: false,
				message:
					'This track is not linked to a provider — quality upgrades are unavailable for uploads.',
			},
			{ status: 400 },
		);
	}
	const job = await enqueueJob({
		type: 'upgrade_check',
		payload: { trackId: track['id'] },
		trackId: track['id'],
		createdBy: locals.user.id,
	});
	void provider;
	return json({ job: { id: job.id, type: job.type, status: job.status } }, { status: 202 });
};
