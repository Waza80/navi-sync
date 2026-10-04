import { describe, expect, it } from 'vitest';
import { canonicalTrackId, trackPageUrl } from './ids';

describe('canonicalTrackId', () => {
	it('keeps plain numeric ids', () => {
		expect(canonicalTrackId('deezer', '3135556')).toBe('3135556');
	});
	it('extracts the id from a page URL', () => {
		expect(canonicalTrackId('deezer', 'https://www.deezer.com/track/3135556')).toBe('3135556');
	});
	it('heals doubled URLs by taking the last numeric run', () => {
		expect(
			canonicalTrackId(
				'deezer',
				'https://www.deezer.com/track/https://www.deezer.com/track/1176975382',
			),
		).toBe('1176975382');
	});
	it('returns null for empty input', () => {
		expect(canonicalTrackId('deezer', null)).toBeNull();
		expect(canonicalTrackId('deezer', '  ')).toBeNull();
	});
	it('leaves non-deezer ids untouched (tidal ids exceed 15 digits)', () => {
		expect(canonicalTrackId('tidal', '154014286732070912')).toBe('154014286732070912');
	});
});

describe('trackPageUrl', () => {
	it('builds deezer page URLs from bare ids', () => {
		expect(trackPageUrl('deezer', '3135556')).toBe('https://www.deezer.com/track/3135556');
	});
	it('never double-prefixes an already-full URL', () => {
		expect(trackPageUrl('deezer', 'https://www.deezer.com/track/3135556')).toBe(
			'https://www.deezer.com/track/3135556',
		);
	});
	it('heals doubled URLs', () => {
		expect(
			trackPageUrl(
				'deezer',
				'https://www.deezer.com/track/https://www.deezer.com/track/1176975382',
			),
		).toBe('https://www.deezer.com/track/1176975382');
	});
	it('builds tidal page URLs', () => {
		expect(trackPageUrl('tidal', '154014286732070912')).toBe(
			'https://tidal.com/track/154014286732070912',
		);
	});
	it('returns null when there is no id', () => {
		expect(trackPageUrl('deezer', null)).toBeNull();
	});
});
