import { describe, expect, it } from 'vitest';
import { instanceTrackId, parseTidalInput } from './parse';

describe('parseTidalInput', () => {
	it('parses tidal.com track links', () => {
		expect(parseTidalInput('https://tidal.com/track/20115564')).toEqual({
			kind: 'track',
			id: '20115564',
		});
	});

	it('parses listen.tidal.com browse links', () => {
		expect(parseTidalInput('https://listen.tidal.com/browse/track/254833237')?.id).toBe(
			'254833237',
		);
		expect(parseTidalInput('https://listen.tidal.com/browse/album/77640617')?.kind).toBe(
			'album',
		);
	});

	it('parses tidal:// scheme links', () => {
		expect(parseTidalInput('tidal://track/12345')).toEqual({ kind: 'track', id: '12345' });
	});

	it('parses bare numeric ids as tracks', () => {
		expect(parseTidalInput('254833237')).toEqual({ kind: 'track', id: '254833237' });
	});

	it('recognises a playlist UUID', () => {
		expect(parseTidalInput('2cb1f0b6-1a3e-4c2f-9f7a-1d2e3f4a5b6c')?.kind).toBe('playlist');
	});

	it('parses artist links', () => {
		expect(parseTidalInput('https://tidal.com/artist/8847')).toEqual({
			kind: 'artist',
			id: '8847',
		});
	});

	it('trims surrounding whitespace', () => {
		expect(parseTidalInput('  20115564 \n')?.id).toBe('20115564');
	});

	it('returns null for unrelated input', () => {
		expect(parseTidalInput('not a link')).toBeNull();
		expect(parseTidalInput('')).toBeNull();
		expect(parseTidalInput('https://example.com/other/1')).toBeNull();
	});

	// Regression guard: Tidal is checked first in the registry, so a Deezer
	// link must NOT parse here — otherwise Deezer links get silently shadowed.
	it("does not claim another provider's track link", () => {
		expect(parseTidalInput('https://www.deezer.com/track/1234567')).toBeNull();
		expect(parseTidalInput('https://www.deezer.com/album/456')).toBeNull();
		expect(parseTidalInput('https://www.deezer.com/artist/789')).toBeNull();
	});

	it('does not claim an unrelated host that happens to say /track/', () => {
		expect(parseTidalInput('https://example.com/track/1234567')).toBeNull();
		expect(parseTidalInput('https://evil.example/track/1?next=/track/2')).toBeNull();
	});

	it('does not claim tidal.com.lookalike.tld', () => {
		expect(parseTidalInput('https://tidal.com.evil.test/track/123')).toBeNull();
	});

	it('does not claim an unknown instance host', () => {
		// Only the CONFIGURED instance may serve these paths; see
		// instanceTrackId(), which the provider calls with that URL.
		expect(parseTidalInput('https://hifi.example.com/track/999')).toBeNull();
	});

	// The `?id=` form is unambiguous enough to accept from any host: it is the
	// instance API's own query shape, and no other provider uses it.
	it('accepts the instance ?id= form from any host', () => {
		expect(parseTidalInput('https://hifi.orbitsc.net/track/?id=20115564')?.id).toBe('20115564');
	});
});

describe('instanceTrackId', () => {
	const INSTANCE = 'https://hifi.orbitsc.net';

	it('reads the ?id= form from the configured instance', () => {
		expect(instanceTrackId(`${INSTANCE}/track/?id=20115564`, INSTANCE)).toBe('20115564');
	});

	it('reads the path form from the configured instance', () => {
		expect(instanceTrackId(`${INSTANCE}/track/20115564`, INSTANCE)).toBe('20115564');
	});

	it('ignores the same path on a different host', () => {
		expect(instanceTrackId('https://www.deezer.com/track/1234567', INSTANCE)).toBeNull();
		expect(instanceTrackId('https://other.example/track/1234567', INSTANCE)).toBeNull();
	});

	it('ignores a lookalike host', () => {
		expect(instanceTrackId('https://hifi.orbitsc.net.evil.test/track/1', INSTANCE)).toBeNull();
	});

	it('tolerates a missing or malformed instance URL', () => {
		expect(instanceTrackId(`${INSTANCE}/track/?id=5`, null)).toBeNull();
		expect(instanceTrackId(`${INSTANCE}/track/?id=5`, 'not a url')).toBeNull();
		expect(instanceTrackId('not a url', INSTANCE)).toBeNull();
	});

	it('matches a subpath instance URL consistently', () => {
		expect(
			instanceTrackId('https://host.test/hifi/track/?id=77', 'https://host.test/hifi'),
		).toBe('77');
	});
});
