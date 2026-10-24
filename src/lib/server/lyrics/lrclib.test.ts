import { describe, expect, it } from 'vitest';
import { pickLrclibRecord, type LrcLibRecord } from './lrclib';

function record(over: Partial<LrcLibRecord> = {}): LrcLibRecord {
	return {
		id: 1,
		trackName: 'Creep',
		artistName: 'Radiohead',
		albumName: 'Pablo Honey',
		duration: 239,
		instrumental: false,
		plainLyrics: 'plain words',
		syncedLyrics: '[00:19.16] When you were here before',
		...over,
	};
}

describe('pickLrclibRecord (duration guard)', () => {
	it('accepts a record within the strict window', () => {
		const result = pickLrclibRecord([record({ duration: 240 })], {
			title: 'Creep',
			artist: 'Radiohead',
			durationSec: 239,
		});
		expect(result?.synced).toContain('When you were here before');
	});

	it('accepts a modest drift (long intro/outro) but still synced', () => {
		const result = pickLrclibRecord([record({ duration: 245 })], {
			title: 'Creep',
			artist: 'Radiohead',
			durationSec: 239,
		});
		expect(result?.synced).not.toBeNull();
	});

	it('REJECTS a distant record instead of ignoring duration', () => {
		// 239 s studio vs 259 s live version: the old fallback picked the live one.
		expect(
			pickLrclibRecord([record({ duration: 259 })], {
				title: 'Creep',
				artist: 'Radiohead',
				durationSec: 239,
			}),
		).toBeNull();
	});

	it('prefers synced over plain inside the window', () => {
		const result = pickLrclibRecord(
			[record({ duration: 239, syncedLyrics: null }), record({ duration: 240 })],
			{ title: 'Creep', artist: 'Radiohead', durationSec: 239 },
		);
		expect(result?.synced).not.toBeNull();
	});

	it('rejects a cover by a different artist', () => {
		expect(
			pickLrclibRecord([record({ artistName: 'Karaoke Hits' })], {
				title: 'Creep',
				artist: 'Radiohead',
				durationSec: 239,
			}),
		).toBeNull();
	});

	it('rejects a different song with a similar title', () => {
		expect(
			pickLrclibRecord([record({ trackName: 'Creep (Live)' })], {
				title: 'Creep',
				artist: 'Radiohead',
				durationSec: 239,
			}),
		).toBeNull();
	});

	it('filters instrumentals', () => {
		expect(
			pickLrclibRecord([record({ instrumental: true })], {
				title: 'Creep',
				artist: 'Radiohead',
				durationSec: 239,
			}),
		).toBeNull();
	});

	it('accepts the ranked first synced when the query has no duration', () => {
		const result = pickLrclibRecord(
			[record({ duration: 500, syncedLyrics: null }), record({ duration: 999 })],
			{ title: 'Creep', artist: 'Radiohead', durationSec: null },
		);
		expect(result?.synced).not.toBeNull();
	});
});
