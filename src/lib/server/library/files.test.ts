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
