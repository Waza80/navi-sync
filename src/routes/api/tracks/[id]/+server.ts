import { z } from 'zod';
import { json, badRequest, notFound, unauthorizedResponse } from '$lib/server/api';
import { deleteTrackRow, getTrackById } from '$lib/server/db/tracks';
import { logger } from '$lib/server/logger';
import { rm } from 'node:fs/promises';
import type { RequestHandler } from './$types';

const log = logger;

const schema = z.object({ confirmTitle: z.string().max(300).optional() });

/**
 * DELETE /api/tracks/[id] — remove a row from the library, permanently.
 *
 * For a FAILED row this deletes the database entry and nothing else: there is no
 * file, because a failed download never produced one. That is what the button on a
 * failed row means — "remove this", not "stop trying".
 *
 * The previous version only set `refetch_blocked`, which excluded the row from
 * every listing while leaving it in the database forever. That was a reversible
 * mute presented as an action, and the button gave no feedback because `refetchBlocked`
 * was never on the DTO — so it looked dead. A row you asked to forget is now gone.
 *
 * A row that DOES own a file is not silently deleted: the file is removed too, and
 * if that fails the row is left in place and the error is reported, so the database
 * can never claim a file that is gone or orphan a file it still points at.
 */
export const DELETE: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) return unauthorizedResponse();

	const parsed = schema.safeParse(await request.json().catch(() => ({})));
	if (!parsed.success) return badRequest('Invalid body.', 'INVALID_BODY');

	const track = await getTrackById(params.id);
	if (!track) return notFound('Track not found');

	if (typeof track.filePath === 'string' && track.filePath.length > 0) {
		try {
			await rm(track.filePath, { force: true });
		} catch (err) {
			// The row stays so the library still points at a file that exists.
			log.warn('delete failed at the file stage; row kept', {
				trackId: track.id,
				path: track.filePath,
				error: String(err),
			});
			return json(
				{
					error: {
						code: 'FILE_DELETE_FAILED',
						message: `Could not delete the audio file, so the entry was kept: ${String(err)}`,
					},
				},
				{ status: 500 },
			);
		}
	}

	// Cancel its queued work FIRST: a running job could otherwise write a file back
	// for a row that is about to be gone, or dead-letter on "track not found".
	const { cancelJobsForTrack } = await import('$lib/server/queue/jobs');
	const cancelled = await cancelJobsForTrack(track.id);

	const removed = await deleteTrackRow(track.id);
	if (!removed) {
		return json(
			{ error: { code: 'DELETE_FAILED', message: 'The row could not be deleted.' } },
			{ status: 500 },
		);
	}

	log.info('track row deleted', {
		trackId: track.id,
		title: track.title,
		artist: track.artist,
		hadFile: typeof track.filePath === 'string' && track.filePath.length > 0,
		by: locals.user.id,
	});

	return json({ id: track.id, deleted: true, cancelledJobs: cancelled });
};
