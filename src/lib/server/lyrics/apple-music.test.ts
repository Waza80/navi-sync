import { describe, expect, it } from 'vitest';
import { paxLinesToLrc, pickAppleSong } from './apple-music';

function appleSong(
	over: {
		name?: string;
		artistName?: string;
		albumName?: string;
		durationInMillis?: number;
		isrc?: string;
	} = {},
) {
	return {
		id: 'song-1',
		attributes: {
			name: 'Bahia',
			artistName: 'Luidji',
			albumName: 'Bahia',
			durationInMillis: 172_000,
			isrc: 'FR9W12320132',
			...over,
		},
	};
}

describe('paxLinesToLrc (Apple Music / Pax)', () => {
	it('builds LRC timestamps from millisecond line data', () => {
		const lrc = paxLinesToLrc([
			{
				text: [{ text: 'Look ' }, { text: 'at', part: true }, { text: ' the', part: true }],
				timestamp: 0,
			},
			{ text: [{ text: 'stars' }], timestamp: 65123, endtime: 68000 },
		]);
		expect(lrc).toBe('[00:00.00]Look at the\n[01:05.12]stars');
	});
	it('returns null for empty input', () => {
		expect(paxLinesToLrc([])).toBeNull();
	});
});

describe('pickAppleSong (exactness before fuzzy score)', () => {
	const q = { title: 'Bahia', artist: 'Luidji', album: 'Bahia', durationSec: 172 };

	it('selects the ISRC match outright', () => {
		const wrong = appleSong({
			name: 'Bahia (Live)',
			artistName: 'Someone Else',
			durationInMillis: 300_000,
			isrc: 'ZZZZ00000000',
		});
		const right = appleSong();
		expect(pickAppleSong([wrong, right], { ...q, isrc: 'FR9W12320132' })).toBe(right);
	});

	it('rejects a same-title track by another artist', () => {
		expect(pickAppleSong([appleSong({ artistName: 'Karaoke Hits' })], q)).toBeNull();
	});

	it('rejects a duration that belongs to a different version', () => {
		expect(pickAppleSong([appleSong({ durationInMillis: 230_000 })], q)).toBeNull();
	});

	it('accepts title + artist + close duration', () => {
		const song = appleSong({ durationInMillis: 173_000 });
		expect(pickAppleSong([song], q)).toBe(song);
	});

	it('falls back to the strict search when no ISRC matches', () => {
		const song = appleSong({ isrc: 'OTHER0000000' });
		expect(pickAppleSong([song], { ...q, isrc: 'FR9W12320132' })).toBe(song);
	});
});
