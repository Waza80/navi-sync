import { describe, expect, it } from 'vitest';
import { canonicalArtistList, unifiedAlbumArtist } from './artists';

// The real credit strings from PRETTY DOLLCORPSE, in the exact shape that
// produced two artist directories. Both repeat names: the ten-track variant has
// `Ptite Soeur` twice, `neophron` twice and `prxpvne` three times.
const TEN =
	'Ptite Soeur, neophron, FEMTOGO, Ptite Soeur, FEMTOGO, neophron, prxpvne, prxpvne, rosaliedu38, prxpvne';
const THREE =
	'Ptite Soeur, neophron, FEMTOGO, Ptite Soeur, FEMTOGO, reivilose, neophron, prxpvne, prxpvne, rosaliedu38, prxpvne';

describe('canonicalArtistList', () => {
	it('drops repeated names, keeping first-seen order', () => {
		expect(canonicalArtistList(TEN)).toBe(
			'Ptite Soeur, neophron, FEMTOGO, prxpvne, rosaliedu38',
		);
	});

	it('leaves a single-artist string otherwise intact', () => {
		expect(canonicalArtistList('Tanger')).toBe('Tanger');
		// Interior whitespace runs are collapsed: that is the documented noise
		// handling, so the output is the tidied form, not the raw input.
		expect(canonicalArtistList('Kinn  ∧  Trios')).toBe('Kinn ∧ Trios');
	});

	it('is idempotent, so applying it twice is safe', () => {
		const once = canonicalArtistList(TEN);
		expect(canonicalArtistList(once)).toBe(once);
	});

	it('treats case variants as one name but keeps the first spelling', () => {
		expect(canonicalArtistList('FEMTOGO, femtogo, Femtogo')).toBe('FEMTOGO');
	});

	it('handles the separators providers use', () => {
		expect(canonicalArtistList('A; B, A; B')).toBe('A, B');
		expect(canonicalArtistList('A / B / A')).toBe('A, B');
	});

	it('canonicalises to NFC so zalgo credits do not fork a name', () => {
		const reordered = '#CUT4\u0362\u031F\u034EZ';
		const ordered = '#CUT4\u031F\u034E\u0362Z';
		expect(canonicalArtistList(reordered + ', ' + ordered)).toBe(ordered.normalize('NFC'));
	});

	it('collapses the whitespace and separator noise a joined list arrives with', () => {
		expect(canonicalArtistList('A ,  B ,A')).toBe('A, B');
	});

	it('returns the input untouched when there is nothing to parse', () => {
		// No names at all — nothing to dedupe, so nothing is invented or removed.
		expect(canonicalArtistList(' , , ')).toBe(' , , ');
	});
});

describe('unifiedAlbumArtist', () => {
	it('the two variants differ on their own — that is why they split', () => {
		expect(unifiedAlbumArtist([TEN])).not.toBe(unifiedAlbumArtist([THREE]));
	});

	it('collapses all thirteen rows to ONE value, keeping every credit', () => {
		const merged = unifiedAlbumArtist([
			...Array<string>(10).fill(TEN),
			...Array<string>(3).fill(THREE),
		]);
		// First-seen order: the ten-track variant contributes prxpvne and
		// rosaliedu38 before reivilose is reached on track 11.
		expect(merged).toBe('Ptite Soeur, neophron, FEMTOGO, prxpvne, rosaliedu38, reivilose');
	});

	it('unions rather than majority-votes, so a minority credit is not dropped', () => {
		// `reivilose` is on 3 of 13 tracks and must still survive.
		expect(unifiedAlbumArtist([...Array<string>(10).fill(TEN), THREE])).toContain('reivilose');
	});

	it('credits the same NAMES however the rows are grouped', () => {
		// Order is deliberately first-seen, so it does track row order. What must
		// NOT vary is the membership — a regrouped album cannot gain or lose a
		// credit, or the split would come back in a new shape.
		const all = [...Array<string>(10).fill(TEN), ...Array<string>(3).fill(THREE)];
		const asSet = (v: string | null) => new Set((v ?? '').split(', '));
		const forward = asSet(unifiedAlbumArtist(all));
		const backward = asSet(unifiedAlbumArtist(all.slice().reverse()));
		expect([...backward].sort()).toEqual([...forward].sort());
		expect(forward.size).toBe(6);
	});

	it('returns null when no row carries one', () => {
		expect(unifiedAlbumArtist([])).toBeNull();
		expect(unifiedAlbumArtist([null, undefined, '', '   '])).toBeNull();
	});

	it('ignores rows with no value instead of collapsing the whole album', () => {
		expect(unifiedAlbumArtist([null, 'A, B', undefined, 'B, A'])).toBe('A, B');
	});

	it('agrees with canonicalArtistList for a single consistent album', () => {
		expect(unifiedAlbumArtist(['A, B, A'])).toBe(canonicalArtistList('A, B, A'));
	});
});
