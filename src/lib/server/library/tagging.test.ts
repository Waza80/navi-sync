import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildVorbisFields, tagMp3 } from './tagging';

const exec = promisify(execFile);

/** A tiny but valid MP3: 16 silent MPEG frames is enough for an ID3 writer. */
async function makeMp3(dir: string, name: string): Promise<string> {
	const path = join(dir, name);
	// 0xFF 0xFB frame header + padding, repeated to look like real MPEG audio.
	const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);
	await writeFile(path, Buffer.concat(Array.from({ length: 32 }, () => frame)));
	return path;
}

async function readTags(path: string): Promise<Record<string, unknown>> {
	const { stdout } = await exec('ffprobe', [
		'-v',
		'error',
		'-show_entries',
		'format_tags',
		'-of',
		'json',
		path,
	]);
	return JSON.parse(stdout).format?.tags ?? {};
}

describe('tagMp3', () => {
	it('writes tags even when every optional field is absent', async () => {
		// Regression: the frame map used to be built with explicit
		// `undefined` values (`synchronisedLyrics: undefined`). node-id3
		// iterates the object's own KEYS, so it dereferenced that undefined into
		// an upstream typo ('lycics.language') and threw — which silently
		// discarded the whole tag write and filed every MP3 upload untagged.
		const dir = await mkdtemp(join(tmpdir(), 'tagmp3-'));
		try {
			const src = await makeMp3(dir, 'src.mp3');
			const out = join(dir, 'out.mp3');
			await copyFile(src, out);

			tagMp3(out, {
				title: 'BULL TERRIER',
				artist: 'reggie petrucci',
				album: null,
				albumArtist: null,
				trackNumber: null,
				discNumber: null,
				year: null,
				genre: null,
				cover: null,
				lyricsPlain: null,
				lyricsSynced: null,
			});

			const tags = await readTags(out);
			expect(tags['title']).toBe('BULL TERRIER');
			expect(tags['artist']).toBe('reggie petrucci');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('embeds synced lyrics in a USLT frame with timestamps intact', async () => {
		// SYLT is unusable in this node-id3 version (it throws
		// "An integer value is expected"), so synced lyrics ride in `lyrics`,
		// which is what Navidrome's mappings.yaml reads via `uslt:description`.
		const dir = await mkdtemp(join(tmpdir(), 'tagmp3-lyr-'));
		try {
			const src = await makeMp3(dir, 'src.mp3');
			const out = join(dir, 'out.mp3');
			await copyFile(src, out);

			tagMp3(out, {
				title: 'T',
				artist: 'A',
				album: 'AL',
				albumArtist: 'A',
				trackNumber: 1,
				discNumber: null,
				year: null,
				genre: null,
				cover: null,
				lyricsPlain: 'plain words',
				lyricsSynced: '[00:12.34]première ligne\n[00:15.00]seconde ligne',
			});

			const { stdout } = await exec('ffprobe', [
				'-v',
				'error',
				'-show_entries',
				'format_tags',
				'-of',
				'default=nw=1',
				out,
			]);
			// The timestamps must survive verbatim — Navidrome derives "synced"
			// from them, and stripped timestamps are why lyrics never displayed.
			expect(stdout).toContain('[00:12.34]');
			expect(stdout).toContain('première ligne');
			expect(stdout).toContain('seconde ligne');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('buildVorbisFields', () => {
	it('emits LYRICS and LRC so Navidrome has both forms', () => {
		const fields = buildVorbisFields({
			title: 'T',
			artist: 'A',
			album: 'AL',
			albumArtist: 'A',
			trackNumber: 1,
			discNumber: null,
			year: null,
			genre: null,
			cover: null,
			lyricsPlain: 'plain',
			lyricsSynced: '[00:01.00]plain',
		});
		const names = fields.map(([n]) => n);
		// Navidrome maps `lyrics` (alias `unsyncedlyrics`) but NOT `LRC`; the
		// timestamped form is what makes the player highlight lines.
		expect(names).toContain('LYRICS');
		expect(names).toContain('LRC');
		expect(fields.find(([n]) => n === 'LYRICS')?.[1]).toBe('plain');
	});

	it('keeps non-ASCII values byte-exact', () => {
		// The corruption being guarded against: metaflac transcoding to the
		// process charset turned every combining mark into '#'.
		const zalgo = 'Ǯ̵͈҉҉̣͜Ọ̴̩́';
		const fields = buildVorbisFields({
			title: zalgo,
			artist: 'Ptite Soeur',
			album: zalgo,
			albumArtist: 'Ptite Soeur',
			trackNumber: 2,
			discNumber: null,
			year: null,
			genre: null,
			cover: null,
			lyricsPlain: null,
			lyricsSynced: null,
		});
		expect(fields.find(([n]) => n === 'TITLE')?.[1]).toBe(zalgo);
	});
});

void readFile;
