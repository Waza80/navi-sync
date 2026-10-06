import { describe, expect, it } from 'vitest';
import {
	sanitizeComponent,
	trackRelativePath,
	lyricsFilePath,
	coverRelativePath,
	trackBaseRelativePath,
} from './paths';
import { splitTrackFilename } from './reconcile';

describe('sanitizeComponent', () => {
	it('strips path traversal and hostile characters', () => {
		expect(sanitizeComponent('../../etc/passwd')).toBe('etcpasswd');
		expect(sanitizeComponent('AC/DC')).toBe('ACDC');
		expect(sanitizeComponent('C:\\Windows\\evil')).toBe('CWindowsevil');
	});
	it('neutralizes windows reserved device names', () => {
		expect(sanitizeComponent('CON')).toBe('_CON');
		expect(sanitizeComponent('nul')).toBe('_nul');
	});
	it('trims dots to prevent hidden/relative names', () => {
		expect(sanitizeComponent('..hidden.')).toBe('hidden');
	});
	it('falls back for empty input', () => {
		expect(sanitizeComponent('///')).toBe('Unknown');
		expect(sanitizeComponent('', 'Unknown Artist')).toBe('Unknown Artist');
	});
	// The cap is in BYTES (ext4's limit is per byte, not per character).
	it('caps extreme lengths by bytes, not characters', () => {
		const out = sanitizeComponent('a'.repeat(500));
		expect(out.length).toBeLessThanOrEqual(220);
		expect(Buffer.byteLength(out)).toBeLessThanOrEqual(220);
	});

	it('keeps a multi-byte title under the filesystem limit', () => {
		// 120 CJK characters are 360 bytes — over ext4's 255-byte cap.
		const cjk = sanitizeComponent('封'.repeat(120));
		expect(Buffer.byteLength(cjk)).toBeLessThanOrEqual(255);
	});

	it('never splits a grapheme cluster when truncating', () => {
		// 'é' as e + combining acute must never be cut between base and mark.
		const out = sanitizeComponent('é'.repeat(400));
		expect(out).not.toContain('́');
		expect(out.endsWith('é')).toBe(true);
	});

	it('preserves zalgo decoration whole', () => {
		const zalgo = `#CUT4${'̟'.repeat(12)}ZALGO`;
		expect(sanitizeComponent(zalgo)).toBe(zalgo);
	});
});

describe('trackRelativePath — Navidrome layout', () => {
	it('produces Artist/Album/NN - Title.ext', () => {
		const p = trackRelativePath(
			{
				title: 'Harder, Better, Faster, Stronger',
				artist: 'Daft Punk',
				album: 'Discovery',
				trackNumber: 4,
			},
			'mp3',
		);
		expect(p).toBe('Daft Punk/Discovery/04 - Harder, Better, Faster, Stronger.mp3');
	});
	it('pads single-digit track numbers and defaults missing album', () => {
		const p = trackRelativePath(
			{ title: 'X', artist: 'Y', album: null, trackNumber: 7 },
			'flac',
		);
		expect(p).toBe('Y/Unknown Album/07 - X.flac');
	});
	it('never contains backslashes or traversal', () => {
		const p = trackRelativePath(
			{ title: '../..', artist: 'a/b', album: 'c\\d', trackNumber: 1 },
			'mp3',
		);
		expect(p).not.toMatch(/[\\\\]/);
		expect(p).not.toContain('..');
	});
});

describe('lyricsFilePath', () => {
	it('swaps the extension keeping the basename and directory', () => {
		expect(lyricsFilePath('Artist/Album/04 - Song.mp3', 'lrc')).toBe(
			'Artist/Album/04 - Song.lrc',
		);
		expect(lyricsFilePath('Artist/Album/04 - Song.mp3', 'txt')).toBe(
			'Artist/Album/04 - Song.txt',
		);
	});
});

describe('coverRelativePath', () => {
	it('places cover.jpg in the album folder', () => {
		expect(coverRelativePath({ title: 'X', artist: 'A', album: 'B' })).toBe('A/B/cover.jpg');
	});
});

describe('trackBaseRelativePath track-number prefix', () => {
	it('omits the prefix entirely when there is no track number', () => {
		// It used to emit '00 - ', which asserted a track 0 that does not exist.
		for (const trackNumber of [null, undefined, 0, -1, Number.NaN, 1000]) {
			expect(
				trackBaseRelativePath({ artist: 'A', album: 'B', title: 'T', trackNumber }),
			).toBe('A/B/T');
		}
	});

	it('pads a real track number to two digits', () => {
		expect(trackBaseRelativePath({ artist: 'A', album: 'B', title: 'T', trackNumber: 1 })).toBe(
			'A/B/01 - T',
		);
		expect(
			trackBaseRelativePath({ artist: 'A', album: 'B', title: 'T', trackNumber: 13 }),
		).toBe('A/B/13 - T');
	});

	it('leaves a title that starts with digits alone', () => {
		// '100 000 LUMEN' must not become '100 - 100 000 LUMEN'.
		expect(
			trackBaseRelativePath({
				artist: 'A',
				album: 'B',
				title: '100 000 LUMEN',
				trackNumber: null,
			}),
		).toBe('A/B/100 000 LUMEN');
	});

	it('round-trips through splitTrackFilename', () => {
		const p = trackBaseRelativePath({
			artist: 'A',
			album: 'B',
			title: '100 000 LUMEN',
			trackNumber: null,
		});
		expect(splitTrackFilename(p.split('/').pop()!)).toEqual({
			trackNumber: null,
			title: '100 000 LUMEN',
		});
	});
});
