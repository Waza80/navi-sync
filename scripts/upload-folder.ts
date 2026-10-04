import 'dotenv/config';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseFile } from 'music-metadata';
import type { TrackMeta } from '../src/lib/server/providers/types';

/**
 * Bulk-upload a local folder through the same pipeline the web UI uses.
 *
 * Deliberately thin: it stages each file into MUSIC_TMP_DIR and then calls the
 * shared helpers that /api/upload composes (dedupe → tag → lyrics → probe →
 * file into library → upsert row). Nothing here re-implements filing, so a
 * track uploaded this way is identical to one dragged into the browser —
 * including the measured duration and bit depth the upgrade engine relies on.
 *
 * Usage:
 *   bun scripts/upload-folder.ts "/path/to/folder" [--dry-run]
 */

// Imported after dotenv/config so env validation sees the right values.
const { env } = await import('../src/lib/server/env');
const { cleanupTemp, moveIntoLibrary, sha256File } =
	await import('../src/lib/server/library/files');
const { probeQuality, tagFlac, tagMp3 } = await import('../src/lib/server/library/tagging');
const { trackBaseRelativePath } = await import('../src/lib/server/library/paths');
const { findLibraryDuplicate, upsertTrack } = await import('../src/lib/server/db/tracks');
const { downloadLyrics, lyricsSidecar } = await import('../src/lib/server/lyrics');
const { logger } = await import('../src/lib/server/logger');

const log = logger;

/** Thrown when the song is already in the library — a no-op, not a failure. */
class DuplicateError extends Error {}

const DRY = process.argv.includes('--dry-run');
const dir = process.argv[2];
if (!dir) {
	console.error('Usage: bun scripts/upload-folder.ts <folder> [--dry-run]');
	process.exit(1);
}
const AUDIO = /\.(mp3|flac)$/i;

interface Prepared {
	tmpPath: string;
	container: 'mp3' | 'flac';
	meta: TrackMeta;
	embeddedLyrics: boolean;
	sizeBytes: number;
}

/** Strip a leading track number from a filename: "03. Title" → "Title". */
function titleFromName(name: string): string {
	return basename(name, extname(name))
		.replace(/^\s*\d+\s*[.)\-_]\s*/, '')
		.trim();
}

async function prepare(file: string): Promise<Prepared | { skip: string }> {
	const uploadId = randomUUID();
	const ext = extname(file);
	const tmpPath = join(env.MUSIC_TMP_DIR, `upload-${uploadId}${ext}`);
	await writeFile(tmpPath, await readFile(file));

	const info = await parseFile(tmpPath, { duration: true });
	const c = info.common;
	const title = c.title?.trim() || titleFromName(file);
	const artist = c.artist?.trim() || null;
	const album = c.album?.trim() || null;
	// Artist and album drive the library folder, so without them we cannot file
	// the track correctly. Refuse rather than invent a folder name.
	if (!artist) {
		await cleanupTemp(tmpPath);
		return { skip: 'no artist tag' };
	}
	if (!album) {
		await cleanupTemp(tmpPath);
		return { skip: 'no album tag' };
	}

	const meta: TrackMeta = {
		provider: 'upload',
		providerTrackId: uploadId,
		title,
		artist,
		album,
		albumArtist: c.albumartist?.trim() || artist,
		isrc: c.isrc ?? null,
		trackNumber: c.track?.no ?? null,
		discNumber: c.disk?.no ?? null,
		// Measured, not guessed — the upgrade engine compares against it.
		durationSec: info.format.duration ? Math.round(info.format.duration) : null,
		year: typeof c.year === 'number' ? c.year : null,
		genre: c.genre?.trim() || null,
		coverUrl: null,
		sourceUrl: null,
		streamToken: null,
	};
	return {
		tmpPath,
		container: ext.toLowerCase() === '.flac' ? 'flac' : 'mp3',
		meta,
		embeddedLyrics: (c.lyrics?.[0]?.text ?? '').trim().length > 0,
		sizeBytes: (await stat(tmpPath)).size,
	};
}

async function finalize(p: Prepared): Promise<{ trackId: string; filePath: string }> {
	const duplicate = await findLibraryDuplicate(p.meta.title, p.meta.artist);
	if (duplicate?.filePath) {
		await cleanupTemp(p.tmpPath);
		throw new DuplicateError(`already in library (track ${duplicate.id})`);
	}

	const tags = {
		title: p.meta.title,
		artist: p.meta.artist,
		album: p.meta.album,
		albumArtist: p.meta.albumArtist,
		trackNumber: p.meta.trackNumber,
		discNumber: p.meta.discNumber,
		year: p.meta.year,
		genre: p.meta.genre,
		cover: null,
		lyricsPlain: null,
		lyricsSynced: null,
	};
	try {
		if (p.container === 'flac') await tagFlac(p.tmpPath, tags);
		else tagMp3(p.tmpPath, tags);
	} catch (err) {
		log.warn('upload tagging failed, storing untagged', { error: String(err) });
	}

	let lyricsStatus: 'none' | 'synced' | 'plain' | 'failed' = 'none';
	if (p.embeddedLyrics) {
		lyricsStatus = 'plain';
	} else if ((await lyricsSidecar(p.meta)) == null) {
		const r = await downloadLyrics(p.meta);
		if (r.success) lyricsStatus = r.synced ? 'synced' : 'plain';
	}

	const checksum = await sha256File(p.tmpPath);
	const probed = await probeQuality(p.tmpPath).catch(() => null);
	const relPath = `${trackBaseRelativePath(p.meta)}.${p.container}`;
	const finalPath = await moveIntoLibrary(p.tmpPath, relPath);
	await cleanupTemp(p.tmpPath);

	const trackId = await upsertTrack({
		meta: p.meta,
		resolution: {
			url: '',
			format: p.container,
			ext: p.container,
			claimedBitrateKbps: null,
			claimedLossless: p.container === 'flac',
			cipher: 'NONE',
			decryptTrackId: null,
		},
		probed,
		filePath: finalPath,
		coverPath: null,
		sizeBytes: p.sizeBytes,
		checksumSha256: checksum,
		lyricsStatus,
	});
	return { trackId, filePath: finalPath };
}

// ── run ───────────────────────────────────────────────────────────────────
const names = (await readdir(dir))
	.filter((n) => AUDIO.test(n))
	.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
console.log(`${dir}: ${names.length} audio files${DRY ? ' (DRY RUN — nothing written)' : ''}\n`);

let ok = 0;
let duplicates = 0;
let skipped = 0;
let failed = 0;
for (const name of names) {
	const label = name.replace(AUDIO, '');
	try {
		const prepared = await prepare(join(dir, name));
		if ('skip' in prepared) {
			console.log(`  SKIP   ${label.padEnd(28)} ${prepared.skip}`);
			skipped++;
			continue;
		}
		const d = prepared.meta;
		const summary = `${d.artist} — ${d.title} [${d.album}] ${prepared.container} ${d.durationSec ?? '?'}s${d.year ? ` ${d.year}` : ''}`;
		if (DRY) {
			console.log(`  WOULD  ${label.padEnd(28)} ${summary}`);
			await cleanupTemp(prepared.tmpPath);
			ok++;
			continue;
		}
		const { trackId, filePath } = await finalize(prepared);
		console.log(`  OK     ${label.padEnd(28)} ${summary}`);
		console.log(`         ${filePath}`);
		console.log(`         trackId=${trackId}`);
		ok++;
	} catch (err) {
		if (err instanceof DuplicateError) {
			console.log(`  DUP    ${label.padEnd(28)} ${err.message}`);
			duplicates++;
			continue;
		}
		console.log(
			`  FAIL   ${label.padEnd(28)} ${err instanceof Error ? err.message : String(err)}`,
		);
		failed++;
	}
}
console.log(`\nok=${ok} duplicates=${duplicates} skipped=${skipped} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
