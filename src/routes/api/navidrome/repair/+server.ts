import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { getSettings } from '$lib/server/settings';
import { enqueueJob } from '$lib/server/queue/jobs';
import { countLibraryTracks, findMissingFiles, markDownloadStatus } from '$lib/server/db/tracks';
import { countAudioFiles } from '$lib/server/library/files';
import { ping } from '$lib/server/navidrome/subsonic';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = logger;

/**
 * POST /api/navidrome/repair — fix Navidrome indexation.
 *
 * Compares the three sources of truth (files on disk, DB rows, Navidrome),
 * verifies the server is reachable, then enqueues a scan job that waits for
 * completion and stamps synced rows. Responds immediately with the counts so
 * the UI can show what was wrong; the job result carries the outcome.
 */
export const POST: RequestHandler = async ({ locals }) => {
	if (!locals.user) return unauthorizedResponse();
	const user = locals.user;

	const s = await getSettings();
	if (!s.navidromeUrl || !s.navidromeUsername || !s.navidromePassword) {
		return badRequest(
			'Navidrome is not fully configured (URL, username, password).',
			'NOT_CONFIGURED',
		);
	}

	const reachable = await ping(s.navidromeUrl, s.navidromeUsername, s.navidromePassword);
	if (!reachable.ok) {
		return json(
			{
				error: {
					code: 'NAVIDROME_UNREACHABLE',
					message: `Navidrome did not answer: ${reachable.error ?? 'unknown error'}`,
				},
			},
			{ status: 502 },
		);
	}

	const [filesOnDisk, tracksInDb, missing] = await Promise.all([
		countAudioFiles(env.MUSIC_LIBRARY_DIR),
		countLibraryTracks(),
		findMissingFiles(env.MUSIC_LIBRARY_DIR),
	]);
	// Rows this server owns whose file is gone: flip to failed so they show
	// up in the library and the next retry (manual or sweep) re-downloads.
	for (const m of missing) {
		await markDownloadStatus(m.id, 'failed');
	}
	log.info('navidrome repair requested', {
		by: user.id,
		filesOnDisk,
		tracksInDb,
		missingFilesMarked: missing.length,
		serverVersion: reachable.serverVersion,
	});

	const job = await enqueueJob({
		type: 'navidrome_scan',
		payload: { repair: true, filesOnDisk, tracksInDb, missingFilesMarked: missing.length },
		createdBy: user.id,
		priority: 7,
	});
	return json(
		{
			job: { id: job.id, type: job.type, status: job.status },
			filesOnDisk,
			tracksInDb,
			missingFilesMarked: missing.length,
			serverVersion: reachable.serverVersion,
		},
		{ status: 202 },
	);
};
