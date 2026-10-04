import { json, notFound, unauthorizedResponse, serverError } from '$lib/server/api';
import { deleteTrackRow, getTrackById } from '$lib/server/db/tracks';
import { rm } from 'node:fs/promises';
import { logger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = logger;

/** GET /api/tracks/:id */
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return unauthorizedResponse();
	const track = await getTrackById(params.id ?? '');
	if (!track) return notFound('Track not found');
	return json({ track });
};

/**
 * DELETE /api/tracks/:id — GDPR right to erasure: removes the DB row AND the
 * audio/lyrics/cover files from disk.
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return unauthorizedResponse();
	const id = params.id ?? '';
	const track = await getTrackById(id);
	if (!track) return notFound('Track not found');

	const files: string[] = [];
	if (track.filePath) files.push(track.filePath);
	if (track.coverPath) files.push(track.coverPath);
	if (track.filePath) {
		const base = track.filePath.replace(/\.(mp3|flac)$/i, '');
		files.push(`${base}.lrc`, `${base}.txt`);
	}
	for (const f of files) {
		await rm(f, { force: true }).catch((err) =>
			log.warn('file deletion failed', { path: f, error: String(err) }),
		);
	}
	const deleted = await deleteTrackRow(id);
	if (!deleted) return serverError('Track row deletion failed', 'DELETE_FAILED');
	log.info('track deleted (GDPR erasure)', { trackId: id, filesRemoved: files.length });
	return json({ deleted: true, id });
};
