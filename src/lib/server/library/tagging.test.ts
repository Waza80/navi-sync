import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildVorbisFields, tagMp3, type TagData } from './tagging';
import { resolveLibraryPath } from './paths';

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
	const parsed = JSON.parse(stdout) as { format?: { tags?: Record<string, unknown> } };
	return parsed.format?.tags ?? {};
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

describe('resolveLibraryPath', () => {
	const LIB = '/music';

	it('leaves an already-canonical path untouched', () => {
		expect(resolveLibraryPath('/music/Ptite Soeur/Discovery/cover.jpg', LIB)).toBe(
			'/music/Ptite Soeur/Discovery/cover.jpg',
		);
	});

	it('re-anchors a developer machine path onto the container library', () => {
		// 87 rows were stored as `/home/wyzz/navi-sync/music/…`, a path that does
		// not exist inside the container, so `stat(coverPath)` failed and no cover
		// was ever served.
		expect(
			resolveLibraryPath('/home/wyzz/navi-sync/music/Lomepal/Mauvais Ordre/cover.jpg', LIB),
		).toBe('/music/Lomepal/Mauvais Ordre/cover.jpg');
	});

	it('anchors a relative path, which resolved against the process CWD', () => {
		expect(resolveLibraryPath('The Weeknd/After Hours/cover.jpg', LIB)).toBe(
			'/music/The Weeknd/After Hours/cover.jpg',
		);
	});

	it('never emits a doubled separator or a foreign prefix', () => {
		for (const input of [
			'/music/A/B/cover.jpg',
			'/home/me/navi-sync/music/A/B/cover.jpg',
			'A/B/cover.jpg',
			'/home/me/navi-sync/music/',
		]) {
			const out = resolveLibraryPath(input, LIB);
			expect(out).not.toContain('//');
			expect(out.startsWith('/music')).toBe(true);
			expect(out).not.toContain('/home/');
		}
	});

	it('is idempotent', () => {
		const once = resolveLibraryPath('/home/me/x/music/A/B/cover.jpg', LIB);
		expect(resolveLibraryPath(once, LIB)).toBe(once);
	});
});

void readFile;

describe('NFC normalisation of written tag values', () => {
	// The two strings Navidrome split one folder into. Both are the same album
	// title; the combining marks sit in different orders. They are canonically
	// EQUIVALENT and byte-distinct, both 115 bytes — so truncation was never the
	// cause and byte-comparing the tag is exactly what forked the album.
	//
	//   U+031F ccc=220, U+034E ccc=230, U+0362 ccc=232
	// Ordered  : 220, 230, 232  -> already canonical
	// Reordered: 232, 220, 230  -> must be sorted back to canonical
	const mk = (over: Partial<TagData> = {}): TagData => ({
		title: 't',
		artist: 'a',
		album: null,
		albumArtist: null,
		trackNumber: null,
		discNumber: null,
		year: null,
		genre: null,
		cover: null,
		lyricsPlain: null,
		lyricsSynced: null,
		...over,
	});

	const ORDERED = '#CUT4\u031F\u034E\u0362Z';
	const REORDERED = '#CUT4\u0362\u031F\u034EZ';

	it('the two inputs really are distinct byte strings', () => {
		expect(REORDERED).not.toBe(ORDERED);
		expect(REORDERED.normalize('NFC')).toBe(ORDERED.normalize('NFC'));
	});

	it('writes the canonically ordered form even when the source is not', () => {
		const albumOf = (a: string) =>
			buildVorbisFields(mk({ album: a })).find(([k]) => k === 'ALBUM')![1];
		expect(albumOf(REORDERED)).toBe(albumOf(ORDERED));
		expect(albumOf(REORDERED)).toBe(ORDERED.normalize('NFC'));
	});

	it('normalises title, artist, albumArtist and genre too', () => {
		const fields = buildVorbisFields(
			mk({
				title: REORDERED,
				artist: REORDERED,
				album: 'plain',
				albumArtist: REORDERED,
				genre: REORDERED,
			}),
		);
		for (const [, value] of fields) expect(value).toBe(value.normalize('NFC'));
	});

	it('leaves absent fields absent rather than empty', () => {
		expect(buildVorbisFields(mk()).map(([k]) => k)).toEqual(['TITLE', 'ARTIST']);
	});
});
