import { describe, expect, it } from 'vitest';
import { paxLinesToLrc } from './apple-music';

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
