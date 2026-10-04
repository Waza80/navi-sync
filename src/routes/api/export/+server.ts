import { createReadStream } from 'node:fs';
import { ZipArchive } from 'archiver';
import { Readable } from 'node:stream';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { unauthorizedResponse } from '$lib/server/api';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = logger;

/**
 * GET /api/export — streaming ZIP of the whole library (Navidrome layout:
 * Music/Artist/Album/…), compressed, never buffered in memory. Phase-2
 * export contract; individual files are available at /api/tracks/:id/file.
 */
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) return unauthorizedResponse();

	// Level 0 (store): FLAC/MP3 are already compressed — deflating them wastes
	// CPU for ~0% gain. The ZIP is a fast, streamable 1:1 library copy.
	const archive = new ZipArchive({ zlib: { level: 0 } });
	archive.on('warning', (err) => log.warn('archive warning', { error: String(err) }));
	// Library walk runs while the zip streams to the client.
	void walk(env.MUSIC_LIBRARY_DIR, '').catch((err) => {
		log.error('library export walk failed', { error: String(err) });
		archive.abort();
	});

	async function walk(dir: string, prefix: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith('.')) continue;
			const full = join(dir, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(full, rel);
			} else {
				const info = await stat(full).catch(() => null);
				if (!info?.isFile()) continue;
				archive.append(createReadStream(full), {
					name: `Music/${rel.split(sep).join('/')}`,
					size: info.size,
				});
			}
		}
	}

	log.info('library export started', { by: locals.user?.id });
	return new Response(Readable.toWeb(archive) as ReadableStream, {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': 'attachment; filename="navisync-library.zip"',
			'cache-control': 'no-store',
		},
	});
};

void basename;
void relative;
