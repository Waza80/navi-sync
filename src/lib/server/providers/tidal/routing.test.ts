import { describe, expect, it } from 'vitest';
import { instanceTrackId, parseTidalInput } from './parse';

/**
 * Provider ROUTING tests — no network, no config store.
 *
 * These matter more than they look: the registry consults providers in order
 * and Tidal leads (it reaches 24/192). Any input Tidal claims but should not
 * shadows the provider that actually owns it, silently and invisibly.
 */

describe('routing: a link goes to the provider that owns it', () => {
	const CLAIMED_BY_TIDAL = [
		'https://tidal.com/track/20115564',
		'https://listen.tidal.com/browse/album/77640617',
		'https://tidal.com/artist/8847',
		'tidal://track/20115564',
		'https://hifi.orbitsc.net/track/?id=20115564',
	];

	const NOT_TIDAL = [
		'https://www.deezer.com/track/1234567',
		'https://www.deezer.com/album/456',
		'https://www.deezer.com/artist/789',
		'https://example.com/track/1234567',
		'https://tidal.com.evil.test/track/1',
		'https://notdeezer.com/track/1',
	];

	it.each(CLAIMED_BY_TIDAL)('claims %s', (url) => {
		expect(parseTidalInput(url)).not.toBeNull();
	});

	it.each(NOT_TIDAL)('does not claim %s', (url) => {
		expect(parseTidalInput(url)).toBeNull();
	});

	it('does not let an unconfigured instance host shadow another provider', () => {
		// hifi.example.com is NOT the configured instance, so this is just a URL.
		expect(
			instanceTrackId('https://hifi.example.com/track/999', 'https://hifi.orbitsc.net'),
		).toBeNull();
		expect(parseTidalInput('https://hifi.example.com/track/999')).toBeNull();
	});

	it('claims the configured instance host only', () => {
		const cfg = 'https://hifi.orbitsc.net';
		expect(instanceTrackId(`${cfg}/track/?id=1`, cfg)).toBe('1');
		expect(instanceTrackId(`${cfg}/track/1`, cfg)).toBe('1');
		expect(instanceTrackId(`https://hifi.orbitsc.net.evil.test/track/1`, cfg)).toBeNull();
	});
});
