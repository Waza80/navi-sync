import { describe, expect, it } from 'vitest';
import {
	canonicalArtistList,
	creditedNames,
	mergeCreditLists,
	unifiedAlbumArtist,
	unifyAlbumArtistsByAlbum,
} from './artists';

// The two real credit strings from PRETTY DOLLCORPSE. Both repeat names:
// `Ptite Soeur` twice, `neophron` twice, `prxpvne` three times.
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
		expect(canonicalArtistList('Kinn  ∧  Trios')).toBe('Kinn ∧ Trios');
	});

	it('is idempotent', () => {
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

	it('returns the input untouched when there is nothing to parse', () => {
		expect(canonicalArtistList(' , , ')).toBe(' , , ');
	});
});

describe('mergeCreditLists', () => {
	it('produces exactly the ordering asked for', () => {
		// 'Ptite Soeur, FEMTOGO, neophron' + 'Ptite Soeur, neophron, FEMTOGO, prxpvne'
		// -> 'Ptite Soeur, FEMTOGO, neophron, prxpvne'
		expect(
			mergeCreditLists([
				'Ptite Soeur, FEMTOGO, neophron',
				'Ptite Soeur, neophron, FEMTOGO, prxpvne',
			]),
		).toBe('Ptite Soeur, FEMTOGO, neophron, prxpvne');
	});

	it('is order-independent — the same credits always give the same string', () => {
		const a = mergeCreditLists([
			'Ptite Soeur, FEMTOGO, neophron',
			'Ptite Soeur, neophron, FEMTOGO, prxpvne',
		]);
		const b = mergeCreditLists([
			'Ptite Soeur, neophron, FEMTOGO, prxpvne',
			'Ptite Soeur, FEMTOGO, neophron',
		]);
		expect(a).toBe(b);
		expect(b).toBe('Ptite Soeur, FEMTOGO, neophron, prxpvne');
	});

	it('is stable under permutation of three or more lists', () => {
		const l = ['A, B', 'A, B, C', 'A, C, D'];
		const results = [
			mergeCreditLists(l),
			mergeCreditLists([...l].reverse()),
			mergeCreditLists([l[1], l[2], l[0]]),
			mergeCreditLists([l[2], l[0], l[1]]),
		];
		expect(new Set(results).size).toBe(1);
	});

	it('places a name that only ever appears last, last', () => {
		expect(mergeCreditLists(['A, B', 'A, B, C'])).toBe('A, B, C');
		expect(mergeCreditLists(['A, B, C', 'A, B'])).toBe('A, B, C');
	});

	it('counts a repeated collaborator once, so it cannot out-vote a real credit', () => {
		expect(mergeCreditLists(['A, A, A, A, B', 'A, B, C'])).toBe('A, B, C');
	});

	it('breaks a tie by how many lists credit the name', () => {
		// Both at index 1; `B` is credited by both lists, `C` by one.
		expect(mergeCreditLists(['A, B, C', 'A, C, B'])).toBe('A, B, C');
	});

	it('merges the real thirteen rows to one value, keeping the minority credit', () => {
		expect(
			unifiedAlbumArtist([...Array<string>(10).fill(TEN), ...Array<string>(3).fill(THREE)]),
		).toBe('Ptite Soeur, neophron, FEMTOGO, reivilose, prxpvne, rosaliedu38');
	});

	it('agrees across every permutation of the real thirteen rows', () => {
		const rows = [...Array<string>(10).fill(TEN), ...Array<string>(3).fill(THREE)];
		const want = 'Ptite Soeur, neophron, FEMTOGO, reivilose, prxpvne, rosaliedu38';
		expect(unifiedAlbumArtist(rows)).toBe(want);
		expect(unifiedAlbumArtist(rows.slice().reverse())).toBe(want);
	});

	it('handles nulls, empties and separators-only junk', () => {
		expect(mergeCreditLists([null, '', ' , ; '])).toBe('');
		expect(mergeCreditLists(['A', null, 'B'])).toBe('A, B');
	});

	it('canonicalises zalgo credit lists to one spelling', () => {
		const ordered = '#CUT4\u031F\u034E\u0362Z';
		const reordered = '#CUT4\u0362\u031F\u034EZ';
		expect(mergeCreditLists([ordered, reordered])).toBe(ordered.normalize('NFC'));
	});
});

describe('unifiedAlbumArtist', () => {
	it('returns null when no row carries one', () => {
		expect(unifiedAlbumArtist([])).toBeNull();
		expect(unifiedAlbumArtist([null, undefined, '', '   '])).toBeNull();
	});

	it('does not lose a credit carried by only one row', () => {
		expect(unifiedAlbumArtist(['A, B', null, 'B, A', undefined])).toBe('A, B');
	});
});

describe('creditedNames', () => {
	it('is case-insensitive and order-free', () => {
		expect([...creditedNames('A, b, A')].sort()).toEqual(['a', 'b']);
		expect(creditedNames(null).size).toBe(0);
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

	it('unifies the thirteen rows that grouping by artist could not', () => {
		const rows = [
			...Array.from({ length: 10 }, () => row(TEN, TEN)),
			...Array.from({ length: 3 }, () => row(THREE, THREE)),
		];
		const out = unifyAlbumArtistsByAlbum(rows);
		expect(out.size).toBe(1);
		expect([...out.values()][0]).toBe(
			'Ptite Soeur, neophron, FEMTOGO, reivilose, prxpvne, rosaliedu38',
		);
	});

	it('gives one value per album, not per artist+album pair', () => {
		expect(
			unifyAlbumArtistsByAlbum([row('A, B', 'A, B'), row('A, B, C', 'A, B, C')]).size,
		).toBe(1);
	});

	it('does NOT merge two unrelated acts sharing an album title', () => {
		expect(
			unifyAlbumArtistsByAlbum([
				row('Marina', 'Marina', 'Greatest Hits'),
				row('VISUAL ARTS / Key', 'VISUAL ARTS / Key', 'Greatest Hits'),
			]).size,
		).toBe(0);
	});

	it('keeps genuinely distinct albums apart', () => {
		expect(
			[
				...unifyAlbumArtistsByAlbum([row('A', 'A', 'One'), row('B', 'B', 'Two')]).keys(),
			].sort(),
		).toEqual(['One', 'Two']);
	});

	it('still unifies a title with a single artist string', () => {
		expect(
			[
				...unifyAlbumArtistsByAlbum(
					Array(5).fill(row('Tanger', 'Tanger, Tanger', 'Archive')),
				).values(),
			][0],
		).toBe('Tanger');
	});

	it('ignores rows with no album or no album artist', () => {
		expect(
			unifyAlbumArtistsByAlbum([row('A', 'A', ''), row('A', '', 'X'), row('A', 'A', null)])
				.size,
		).toBe(0);
	});

	it('matches albums that differ only by NFC form', () => {
		expect(
			unifyAlbumArtistsByAlbum([
				row('A\u031F\u034E\u0362Z', 'x', 'Z\u031F\u034E\u0362A'),
				row('A\u0362\u031F\u034EZ', 'x', 'Z\u0362\u031F\u034EA'),
			]).size,
		).toBe(1);
	});

	it('is order-independent', () => {
		const rows = [
			...Array.from({ length: 10 }, () => row(TEN, TEN)),
			...Array.from({ length: 3 }, () => row(THREE, THREE)),
		];
		const a = unifyAlbumArtistsByAlbum(rows);
		const b = unifyAlbumArtistsByAlbum(rows.slice().reverse());
		expect([...a.values()][0]).toBe([...b.values()][0]);
	});
});
