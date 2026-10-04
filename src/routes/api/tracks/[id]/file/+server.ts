import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { notFound, unauthorizedResponse } from '$lib/server/api';
import { getTrackById } from '$lib/server/db/tracks';
import type { RequestHandler } from './$types';

/** Wraps a node ReadStream in a DOM ReadableStream (no type conflicts). */
function fileToWebStream(
	path: string,
	range?: { start: number; end: number },
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const node = createReadStream(path, range);
			node.on('data', (chunk) => {
				const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
				controller.enqueue(new Uint8Array(bytes));
			});
			node.on('end', () => controller.close());
			node.on('error', (err) => controller.error(err));
		},
	});
}

/**
 * GET /api/tracks/:id/file — authenticated download of the audio file with
 * HTTP Range support (preview seeking + resumable downloads).
 */
export const GET: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) return unauthorizedResponse();
	const track = await getTrackById(params.id ?? '');
	const filePath = track?.filePath ?? null;
	if (!filePath) return notFound('No audio file');
	const info = await stat(filePath).catch(() => null);
	if (!info?.isFile()) return notFound('File missing from library');

	const type = filePath.toLowerCase().endsWith('.flac') ? 'audio/flac' : 'audio/mpeg';
	const baseHeaders: Record<string, string> = {
		'content-type': type,
		'accept-ranges': 'bytes',
		'cache-control': 'private, max-age=3600',
	};

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
			return new Response(fileToWebStream(filePath, { start, end: safeEnd }), {
				status: 206,
				headers: {
					...baseHeaders,
					'content-length': String(safeEnd - start + 1),
					'content-range': `bytes ${start}-${safeEnd}/${info.size}`,
				},
			});
		}
	}

	return new Response(fileToWebStream(filePath), {
		status: 200,
		headers: { ...baseHeaders, 'content-length': String(info.size) },
	});
};
