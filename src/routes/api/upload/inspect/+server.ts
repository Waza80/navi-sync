import type { RequestHandler } from './$types';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { env } from '$lib/server/env';
import { parseFile } from 'music-metadata';
import { logger } from '$lib/server/logger';

const log = logger;

/**
 * POST /api/upload/inspect — multipart upload of one audio file.
 * Stores it in temp space, probes real tags (smart detection), and returns
 * an uploadId plus detected/missing metadata for the confirmation form.
 * Nothing touches the library until /api/upload finalizes.
 */

const MAX_BYTES = 400 * 1024 * 1024; // safety clamp alongside BODY_SIZE_LIMIT
const AUDIO_EXT = /\.(mp3|flac|m4a|mp4|aac|ogg|opus|wav)$/i;

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return unauthorizedResponse();

	const form = await request.formData().catch(() => null);
	if (!form)
		return badRequest('Expected multipart/form-data with a "file" field.', 'INVALID_BODY');
	const file = form.get('file');
	if (!(file instanceof File)) return badRequest('Missing "file" field.', 'MISSING_FILE');
	if (file.size === 0 || file.size > MAX_BYTES)
		return badRequest('File is empty or too large.', 'INVALID_FILE');
	if (!AUDIO_EXT.test(file.name)) return badRequest('Unsupported file type.', 'UNSUPPORTED_TYPE');

	const uploadId = randomUUID();
	const tmpPath = join(
		env.MUSIC_TMP_DIR,
		`upload-${uploadId}${file.name.slice(file.name.lastIndexOf('.'))}`,
	);
	await writeFile(tmpPath, Buffer.from(await file.arrayBuffer()));

	// Smart detection: embedded tags first, filename heuristics as fallback.
	let detected: Record<string, unknown> = {};
	let embeddedLyrics: string | null = null;
	try {
		const info = await parseFile(tmpPath, { duration: true });
		const c = info.common;
		embeddedLyrics = c.lyrics?.[0]?.text ?? null;
		detected = {
			title: c.title ?? null,
			artist: c.artist ?? null,
			album: c.album ?? null,
			albumArtist: c.albumartist ?? null,
			trackNumber: c.track?.no ?? null,
			discNumber: c.disk?.no ?? null,
			year: c.year ?? null,
			isrc: c.isrc ?? null,
			genre: c.genre ?? null,
			durationSec: info.format.duration ? Math.round(info.format.duration) : null,
			container: (info.format.container ?? '').toLowerCase(),
			bitDepth: info.format.bitsPerSample ?? null,
			sampleRateHz: info.format.sampleRate ?? null,
			lossless: info.format.lossless ?? null,
		};
	} catch (err) {
		log.warn('upload probe failed, relying on filename heuristics', { error: String(err) });
	}

	// "01 - Artist - Title" or "Artist - Title" from the filename.
	const base = file.name.replace(/\.[^.]+$/, '');
	const hyphen = base.split(' - ');
	if (!detected['artist'] && hyphen.length >= 2) detected['artist'] = hyphen[0].trim();
	if (!detected['title'])
		detected['title'] = (hyphen.length >= 2 ? hyphen.slice(1).join(' - ') : base).trim();

	const missing = ['title', 'artist', 'album'].filter((k) => !detected[k]);
	const dot = file.name.lastIndexOf('.');
	const ext = dot >= 0 ? file.name.slice(dot) : '';

	log.info('upload inspected', {
		uploadId,
		name: file.name,
		bytes: file.size,
		missing: missing.join(',') || 'none',
	});
	return json({ uploadId, ext, detected, embeddedLyrics: embeddedLyrics !== null, missing });
};
