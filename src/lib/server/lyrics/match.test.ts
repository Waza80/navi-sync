import { describe, expect, it } from 'vitest';
import { artistsMatch, durationClose, normalizeForMatch, titlesMatch } from './match';

describe('normalizeForMatch', () => {
	it('strips accents, features and case', () => {
		expect(normalizeForMatch('ÉTATS D’ÂMES (feat. Someone)')).toBe('etats dames');
	});

	it('keeps meaningful qualifiers like live/remix', () => {
		expect(normalizeForMatch('Creep - Live')).toBe('creep live');
		expect(normalizeForMatch('Creep (Remix)')).toBe('creep remix');
	});

	it('normalises ampersands', () => {
		expect(normalizeForMatch('Simon & Garfunkel')).toBe('simon and garfunkel');
	});
});

describe('titlesMatch', () => {
	it('matches equal titles and harmless suffixes', () => {
		expect(titlesMatch('Bahia', 'Bahia')).toBe(true);
		expect(titlesMatch('Bahia (Remastered 2011)', 'Bahia')).toBe(true);
	});

	it('rejects versions carrying a meaningful qualifier', () => {
		expect(titlesMatch('Creep (Live)', 'Creep')).toBe(false);
		expect(titlesMatch('Creep (Remix)', 'Creep')).toBe(false);
	});

	it('rejects unrelated titles', () => {
		expect(titlesMatch('Digital Bath', 'Creep')).toBe(false);
	});
});

describe('artistsMatch', () => {
	it('matches multi-artist credits when one side is a subset', () => {
		expect(artistsMatch('Vald', 'Vald, Hamza')).toBe(true);
		expect(artistsMatch('Theodora', 'Theodora, someone else')).toBe(true);
	});

	it('rejects a different act', () => {
		expect(artistsMatch('Radiohead', 'Karaoke Hits')).toBe(false);
	});

	it('matches accented vs plain spellings', () => {
		expect(artistsMatch('Yamê', 'Yame')).toBe(true);
	});
});

describe('durationClose', () => {
	it('passes unknown durations', () => {
		expect(durationClose(null, 200, 3)).toBe(true);
		expect(durationClose(200, null, 3)).toBe(true);
	});

	it('enforces the window when both are known', () => {
		expect(durationClose(200, 202, 3)).toBe(true);
		expect(durationClose(200, 204, 3)).toBe(false);
	});
});
