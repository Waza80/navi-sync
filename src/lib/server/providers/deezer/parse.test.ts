import { describe, expect, it } from 'vitest';
import { parseDeezerTrackUrl, isDeezerShortLink } from './parse';

describe('parseDeezerTrackUrl', () => {
	it('accepts canonical track URLs across locales', () => {
		expect(parseDeezerTrackUrl('https://www.deezer.com/track/3135556')?.id).toBe('3135556');
		expect(parseDeezerTrackUrl('https://www.deezer.com/us/track/916424')?.id).toBe('916424');
		expect(parseDeezerTrackUrl('http://deezer.com/track/1?utm=x')?.id).toBe('1');
	});
	it('accepts bare ids', () => {
		expect(parseDeezerTrackUrl('3135556')?.id).toBe('3135556');
	});
	it('rejects non-deezer hosts and non-track paths', () => {
		expect(parseDeezerTrackUrl('https://spotify.com/track/3135556')).toBeNull();
		expect(parseDeezerTrackUrl('https://www.deezer.com/album/123')).toBeNull();
		expect(parseDeezerTrackUrl('not a url')).toBeNull();
	});
	it('flags short links for redirect resolution', () => {
		expect(isDeezerShortLink('https://link.deezer.com/s/xAbCd')).toBe(true);
		expect(isDeezerShortLink('https://www.deezer.com/track/1')).toBe(false);
	});
});
