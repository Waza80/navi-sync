import { describe, expect, it } from 'vitest';
import { linesToLrc, plainText } from './deezer-pipe';

describe('plainText (Deezer payload)', () => {
	it('accepts the live API shape (a string), not just arrays', () => {
		// The original port typed this as string[] and called .join(), which threw
		// on the live string payload — every Deezer track then reported no lyrics.
		expect(plainText("J'ai écouté ce qu'on m'a dit\r\nEt j'ai fait l'inverse")).toBe(
			"J'ai écouté ce qu'on m'a dit\nEt j'ai fait l'inverse",
		);
	});

	it('still accepts the older array shape', () => {
		expect(plainText(['line one', 'line two'])).toBe('line one\nline two');
	});

	it('treats empty/blank as absent', () => {
		expect(plainText('')).toBeNull();
		expect(plainText('   \n ')).toBeNull();
		expect(plainText(null)).toBeNull();
		expect(plainText(undefined)).toBeNull();
	});
});

describe('linesToLrc (Deezer synchronized lines)', () => {
	it('prefers milliseconds when present', () => {
		expect(linesToLrc([{ line: 'hello', milliseconds: 20990 }])).toBe('[00:20.99]hello');
	});

	it('falls back to the supplied lrcTimestamp', () => {
		expect(linesToLrc([{ line: 'bonjour', lrcTimestamp: '[00:21.27]' }])).toBe(
			'[00:21.27]bonjour',
		);
	});

	it('keeps minute-scale timestamps correct', () => {
		expect(linesToLrc([{ line: 'late', milliseconds: 3_723_456 }])).toBe('[62:03.45]late');
	});

	it('drops lines with no usable timing instead of stamping them 00:00', () => {
		expect(linesToLrc([{ line: 'untimed' }])).toBeNull();
		expect(linesToLrc([{ line: 'timed', milliseconds: 1000 }, { line: 'untimed' }])).toBe(
			'[00:01.00]timed',
		);
	});

	it('returns null for no lines', () => {
		expect(linesToLrc([])).toBeNull();
	});
});
