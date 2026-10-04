import { describe, expect, it } from 'vitest';
import { sanitizeComponent, trackRelativePath, lyricsFilePath, coverRelativePath } from './paths';

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
	it('caps extreme lengths', () => {
		const out = sanitizeComponent('a'.repeat(500));
		expect(out.length).toBeLessThanOrEqual(120);
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
