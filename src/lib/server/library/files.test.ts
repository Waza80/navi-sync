import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { countAudioFiles } from './files';

describe('countAudioFiles (repair inventory)', () => {
	it('counts audio files recursively and ignores the rest', async () => {
		const root = await mkdtemp(join(tmpdir(), 'navi-count-'));
		await mkdir(join(root, 'Artist', 'Album'), { recursive: true });
		await writeFile(join(root, 'Artist', 'Album', '01 - Song.flac'), 'x');
		await writeFile(join(root, 'Artist', 'Album', '01 - Song.lrc'), 'x');
		await writeFile(join(root, 'Artist', 'Album', 'cover.jpg'), 'x');
		await writeFile(join(root, 'Artist', 'Album', '02 - Other.MP3'), 'x');
		await writeFile(join(root, 'notes.txt'), 'x');
		expect(await countAudioFiles(root)).toBe(2);
	});
	it('returns 0 for a missing directory', async () => {
		expect(await countAudioFiles(join(tmpdir(), 'navi-nope-missing-dir'))).toBe(0);
	});
});

describe('moveIntoLibrary', () => {
	// The suffixing this replaces produced "07 - sludgecrank (2).flac" and "(3).flac"
	// beside the original, and Navidrome greyed the album out because several files
	// claimed one track number. The pipeline now hard-stops a recording we already
	// hold, so a differing second copy should be DROPPED, never suffixed.
	it('keeps the existing file and discards a differing second copy', async () => {
		const { env } = await import('$lib/server/env');
		const { mkdtemp, readFile, readdir } = await import('node:fs/promises');
		const { tmpdir } = await import('node:os');

		const root = await mkdtemp(join(tmpdir(), 'navi-move-'));
		const rel = 'Artist/Album/01 - Song.flac';
		const dest = join(env.MUSIC_LIBRARY_DIR, rel);

		// Pre-place a DIFFERENT file at the destination.
		await mkdir(join(env.MUSIC_LIBRARY_DIR, 'Artist', 'Album'), { recursive: true });
		await writeFile(dest, 'ORIGINAL-CONTENT');
		const src = join(root, 'incoming.flac');
		await writeFile(src, 'DIFFERENT-CONTENT');

		const { moveIntoLibrary } = await import('./files');
		const result = await moveIntoLibrary(src, rel);

		// Returns the path the library indexes, and that file is untouched.
		expect(result).toBe(dest);
		expect(await readFile(dest, 'utf8')).toBe('ORIGINAL-CONTENT');
		// No suffixed sibling was created.
		const names = await readdir(join(env.MUSIC_LIBRARY_DIR, 'Artist', 'Album'));
		expect(names.filter((n) => /\(\d+\)/.test(n))).toEqual([]);
		// The incoming copy is gone rather than left in tmp.
		await expect(readFile(src, 'utf8')).rejects.toThrow();
	});
});
