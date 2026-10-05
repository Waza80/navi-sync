import { describe, expect, it } from 'vitest';
import { parseDeezerUrl, isDeezerShortLink } from './parse';

describe('parseDeezerUrl', () => {
	it('accepts canonical track URLs across locales', () => {
		expect(parseDeezerUrl('https://www.deezer.com/track/3135556')?.id).toBe('3135556');
		expect(parseDeezerUrl('https://www.deezer.com/us/track/916424')?.id).toBe('916424');
		expect(parseDeezerUrl('http://deezer.com/track/1?utm=x')?.id).toBe('1');
	});

	it('accepts bare ids as track refs', () => {
		expect(parseDeezerUrl('3135556')).toEqual({ id: '3135556', kind: 'track' });
	});

	// Regression: a shared ARTIST link resolves to /nl/artist/{id}, and the old
	// track-only regex declined it, so pasting the link reported that it could not
	// be parsed.
	it('classifies artist links, with or without a locale segment', () => {
		expect(parseDeezerUrl('https://www.deezer.com/nl/artist/110750')).toEqual({
			id: '110750',
			kind: 'artist',
		});
		expect(parseDeezerUrl('https://www.deezer.com/artist/27')).toEqual({
			id: '27',
			kind: 'artist',
		});
	});

	it('classifies album links', () => {
		expect(parseDeezerUrl('https://www.deezer.com/album/6575789')).toEqual({
			id: '6575789',
			kind: 'album',
		});
		expect(parseDeezerUrl('https://www.deezer.com/fr/album/12')).toEqual({
			id: '12',
			kind: 'album',
		});
	});

	it('still rejects other hosts and unknown paths', () => {
		expect(parseDeezerUrl('https://spotify.com/track/3135556')).toBeNull();
		expect(parseDeezerUrl('https://www.deezer.com/charts')).toBeNull();
		expect(parseDeezerUrl('not a url')).toBeNull();
	});

	it('flags short links for redirect resolution', () => {
		expect(isDeezerShortLink('https://link.deezer.com/s/xAbCd')).toBe(true);
		expect(isDeezerShortLink('https://www.deezer.com/track/1')).toBe(false);
	});
});
