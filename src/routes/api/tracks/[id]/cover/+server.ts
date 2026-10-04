import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { notFound, unauthorizedResponse } from '$lib/server/api';
import { getTrackById } from '$lib/server/db/tracks';
import type { RequestHandler } from './$types';

/** Wraps a node ReadStream in a DOM ReadableStream (no type conflicts). */
function fileToWebStream(path: string): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const node = createReadStream(path);
			node.on('data', (chunk) => {
				const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
				controller.enqueue(new Uint8Array(bytes));
			});
			node.on('end', () => controller.close());
			node.on('error', (err) => controller.error(err));
		},
	});
}

/** GET /api/tracks/:id/cover — album art for the grid (cover.jpg). */
export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return unauthorizedResponse();
	const track = await getTrackById(params.id ?? '');
	const coverPath = track?.coverPath ?? null;
	if (!coverPath) return notFound('No cover');
	const info = await stat(coverPath).catch(() => null);
	if (!info?.isFile()) return notFound('Cover missing');
	return new Response(fileToWebStream(coverPath), {
		headers: {
			'content-type': 'image/jpeg',
			'content-length': String(info.size),
			'cache-control': 'private, max-age=86400',
		},
	});
};
