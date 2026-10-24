import { describe, expect, it } from 'vitest';
import { pickDeezerMatch } from './deezer-search';
import type { TrackMeta } from '$lib/server/providers/types';

function candidate(over: Partial<TrackMeta> = {}): TrackMeta {
	return {
		provider: 'deezer',
		providerTrackId: '1532500802',
		title: 'otherside (Remix)',
		artist: 'Tanger',
		album: 'otherside',
		albumArtist: 'Tanger',
		isrc: 'QZES82123456',
		trackNumber: null,
		discNumber: null,
		durationSec: 219,
		year: null,
		genre: null,
		coverUrl: null,
		sourceUrl: null,
		streamToken: null,
		...over,
	};
}

describe('pickDeezerMatch (search fallback for non-Deezer rows)', () => {
	const q = {
		title: 'otherside (Remix)',
		artist: 'Tanger',
		album: 'otherside',
		durationSec: 219,
		isrc: null,
	};

	it('accepts an exact title + artist + duration match', () => {
		const hit = candidate();
		expect(pickDeezerMatch([hit], q)).toBe(hit);
	});

	it('rejects a different recording with a close title', () => {
		expect(
			pickDeezerMatch([candidate({ title: 'otherside (Live)', durationSec: 260 })], q),
		).toBeNull();
	});

	it('rejects a same-title track by another artist', () => {
		expect(pickDeezerMatch([candidate({ artist: 'Some Cover Band' })], q)).toBeNull();
	});

	it('rejects a duration-mismatched version even when the title matches', () => {
		expect(pickDeezerMatch([candidate({ durationSec: 260 })], q)).toBeNull();
	});

	it('prefers an ISRC-exact candidate over fuzzy metadata', () => {
		const byIsrc = candidate({
			title: 'Otherside',
			artist: 'Tanger',
			durationSec: 500,
			isrc: 'FR9W12320132',
		});
		expect(pickDeezerMatch([candidate(), byIsrc], { ...q, isrc: 'FR9W12320132' })).toBe(byIsrc);
	});

	it('accepts accented metadata against a plain query', () => {
		const hit = candidate({ title: 'Bizarre', artist: 'Yamê' });
		expect(pickDeezerMatch([hit], { title: 'Bizarre', artist: 'Yame', durationSec: 219 })).toBe(
			hit,
		);
	});
});
