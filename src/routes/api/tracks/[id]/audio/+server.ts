import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { notFound, unauthorizedResponse } from '$lib/server/api';
import { getTrackById } from '$lib/server/db/tracks';
import type { RequestHandler } from './$types';

/**
 * GET /api/tracks/:id/audio — authenticated audio preview with HTTP Range
 * support (seeking). Streams directly from the library file; never exposes
 * paths.
 */
export const GET: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) return unauthorizedResponse();
	const track = await getTrackById(params.id ?? '');
	if (!track) return notFound('Track not found');
	const filePath = track['filePath'];
	if (typeof filePath !== 'string' || filePath.length === 0)
		return notFound('No audio file for track');

	const info = await stat(filePath).catch(() => null);
	if (!info || !info.isFile()) return notFound('Audio file missing from library');

	const type = filePath.toLowerCase().endsWith('.flac') ? 'audio/flac' : 'audio/mpeg';
	const range = request.headers.get('range');

	if (range) {
		const m = /bytes=(\d*)-(\d*)/.exec(range);
		if (m) {
			const start = m[1] ? Number.parseInt(m[1], 10) : 0;
			const end = m[2] ? Number.parseInt(m[2], 10) : info.size - 1;
			if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= info.size) {
				return new Response(null, {
					status: 416,
					headers: { 'content-range': `bytes */${info.size}` },
				});
			}
			const safeEnd = Math.min(end, info.size - 1);
			const stream = Readable.toWeb(
				createReadStream(filePath, { start, end }),
			) as ReadableStream;
			return new Response(stream, {
				status: 206,
				headers: {
					'content-type': type,
					'content-length': String(safeEnd - start + 1),
					'content-range': `bytes ${start}-${safeEnd}/${info.size}`,
					'accept-ranges': 'bytes',
					'cache-control': 'private, max-age=3600',
				},
			});
		}
	}

	const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
	return new Response(stream, {
		status: 200,
		headers: {
			'content-type': type,
			'content-length': String(info.size),
			'accept-ranges': 'bytes',
			'cache-control': 'private, max-age=3600',
		},
	});
};

export const HEAD: RequestHandler = async (event) => {
	const res = await GET(event);
	if (res.status === 200) {
		return new Response(null, { status: 200, headers: res.headers });
	}
	return res;
};
