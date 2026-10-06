import { describe, expect, it } from 'vitest';
import { canonicalArtistList, unifiedAlbumArtist, unifyAlbumArtistsByAlbum } from './artists';

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

describe('unifyAlbumArtistsByAlbum', () => {
	const row = (
		artist: string,
		albumArtist: string,
		album: string | null = 'PRETTY DOLLCORPSE',
	) => ({
		artist,
		albumArtist,
		album,
	});

	// The real data: 13 rows, two artist strings differing by one name, and the
	// tag/DB album artist copied from whichever directory each group came from.
	const ten =
		'Ptite Soeur, neophron, FEMTOGO, Ptite Soeur, FEMTOGO, neophron, prxpvne, prxpvne, rosaliedu38, prxpvne';
	const three =
		'Ptite Soeur, neophron, FEMTOGO, Ptite Soeur, FEMTOGO, reivilose, neophron, prxpvne, prxpvne, rosaliedu38, prxpvne';

	it('unifies the thirteen rows that grouping by artist could not', () => {
		const rows = [
			...Array.from({ length: 10 }, () => row(ten, ten)),
			...Array.from({ length: 3 }, () => row(three, three)),
		];
		const out = unifyAlbumArtistsByAlbum(rows);
		expect(out.size).toBe(1);
		expect([...out.values()][0]).toBe(
			'Ptite Soeur, neophron, FEMTOGO, prxpvne, rosaliedu38, reivilose',
		);
	});

	it('gives one value per album, not per artist+album pair', () => {
		const rows = [row('A, B', 'A, B'), row('A, B, C', 'A, B, C')];
		expect(unifyAlbumArtistsByAlbum(rows).size).toBe(1);
	});

	it('does NOT merge two unrelated acts sharing an album title', () => {
		// "Greatest Hits" by two artists with no credit in common.
		const rows = [
			row('Marina', 'Marina', 'Greatest Hits'),
			row('VISUAL ARTS / Key', 'VISUAL ARTS / Key', 'Greatest Hits'),
		];
		expect(unifyAlbumArtistsByAlbum(rows).size).toBe(0);
	});

	it('keeps genuinely distinct albums apart', () => {
		const rows = [row('A', 'A', 'One'), row('B', 'B', 'Two')];
		const out = unifyAlbumArtistsByAlbum(rows);
		expect([...out.keys()].sort()).toEqual(['One', 'Two']);
	});

	it('still unifies a title with a single artist string', () => {
		const rows = Array.from({ length: 5 }, () => row('Tanger', 'Tanger, Tanger', 'Archive'));
		expect(unifyAlbumArtistsByAlbum(rows).get('Archive')).toBe('Tanger');
	});

	it('ignores rows with no album or no album artist', () => {
		const rows = [row('A', 'A', ''), row('A', '', 'X'), row('A', 'A', null)];
		expect(unifyAlbumArtistsByAlbum(rows).size).toBe(0);
	});

	it('matches albums that differ only by NFC form', () => {
		// Same name, combining marks in different orders, on both the album title
		// and the artist credit — so the two rows must land in ONE group.
		const rows = [
			row('A\u031F\u034E\u0362Z', 'x', 'Z\u031F\u034E\u0362A'),
			row('A\u0362\u031F\u034EZ', 'x', 'Z\u0362\u031F\u034EA'),
		];
		expect(unifyAlbumArtistsByAlbum(rows).size).toBe(1);
	});
});
