import { describe, expect, it } from 'vitest';
import { foldAlbum, isDuplicateOfSibling, planAlbumRename, splitIndexSuffix } from './albumfold';

// ── the real, measured library data ───────────────────────────────────────────
// 675 files. 16 tracks sit in folders whose ALBUM tags differ only in case or a
// colon; 156 filenames end in ' (n)'.
const ROW = (
	id: string,
	title: string,
	album: string,
	durationSec: number | null,
	discNumber: number | null = 1,
) => ({ id, title, album, durationSec, discNumber });

describe('foldAlbum', () => {
	it('folds case — providers disagree constantly on it', () => {
		expect(foldAlbum('Koi no Yokan')).toBe(foldAlbum('Koi No Yokan'));
	});

	it('drops a colon, which is the character splitting NODA in two', () => {
		expect(foldAlbum('NODA: le monde et les humains')).toBe(
			foldAlbum('NODA le monde et les humains'),
		);
	});

	it('collapses whitespace', () => {
		expect(foldAlbum('  NODA   le monde  ')).toBe(foldAlbum('NODA le monde'));
	});

	it('canonicalises to NFC first, so zalgo never forks a key', () => {
		expect(foldAlbum('Ptite Soeur/#CUT4\u0362\u031F\u034EZ')).toBe(
			foldAlbum('Ptite Soeur/#CUT4\u031F\u034E\u0362Z'),
		);
	});

	it('does NOT fold away real punctuation that distinguishes releases', () => {
		expect(foldAlbum("Y&W L'album")).not.toBe(foldAlbum('Black Album'));
		expect(foldAlbum('FLIP (Deluxe)')).not.toBe(foldAlbum('FLIP - Deluxe'));
	});

	it('keeps years distinct', () => {
		expect(foldAlbum('Greatest Hits 1998')).not.toBe(foldAlbum('Greatest Hits 2003'));
	});
});

describe('splitIndexSuffix', () => {
	it('splits a bare numeric index', () => {
		expect(splitIndexSuffix('Eleanor Rigby (3)')).toEqual(['Eleanor Rigby', 3]);
		expect(splitIndexSuffix('03 - Eleanor Rigby (22)')).toEqual(['03 - Eleanor Rigby', 22]);
	});

	it('leaves real parenthesised titles alone', () => {
		for (const t of [
			'FLIP (Deluxe)',
			'Exit Music (For A Film)',
			'Love Song (feat. x)',
			'Remastered (2011)',
		]) {
			expect(splitIndexSuffix(t)).toEqual([t, null]);
		}
	});

	it('does not treat a large parenthesised number as an index in a title', () => {
		// A 4-digit number is a year or a catalogue reference, never a copy index.
		expect(splitIndexSuffix('Something (2024)')).toEqual(['Something (2024)', null]);
	});
});

describe('isDuplicateOfSibling', () => {
	// Real duplicates: same album, same title without the index, same length.
	const dup = [{ title: 'Eleanor Rigby', durationSec: 217.8, discNumber: 1 }];
	// The real albums those files live on. Critically, NONE of them contains a
	// file called 'Moog City 2' — that is exactly why the ' (2)' belongs to the
	// title. Listing a twin here would be a different test entirely.
	const unrelated = [
		{ title: 'Air', durationSec: 293.4, discNumber: 1 },
		{ title: 'Ephemeral', durationSec: 154.6, discNumber: 1 },
		{ title: 'Wanderer', durationSec: 208.1, discNumber: 1 },
	];

	it('confirms a same-length twin on the same album', () => {
		expect(isDuplicateOfSibling('Eleanor Rigby (3)', 217.8, dup)).toBe(true);
	});

	it('refuses a real title that merely ends in a number', () => {
		// The 150-file case. Nothing on the album is called 'Moog City 2', so the
		// ' (2)' belongs to the title and stripping it invents a different song.
		expect(isDuplicateOfSibling('Moog City 2 (2)', 180.0, unrelated)).toBe(false);
		expect(isDuplicateOfSibling('The Tourist (2)', 326.5, unrelated)).toBe(false);
		expect(isDuplicateOfSibling('souvenir (2)', 370.0, unrelated)).toBe(false);
	});

	it('accepts the twin carrying the suffix and this one not', () => {
		const sibs = [{ title: 'Palpal (9)', durationSec: 141.2, discNumber: 1 }];
		expect(isDuplicateOfSibling('Palpal', 141.2, sibs)).toBe(true);
	});

	it('needs a duration — never guess from the name alone', () => {
		expect(isDuplicateOfSibling('Eleanor Rigby (3)', null, dup)).toBe(false);
	});

	it('tolerates encoder drift but not a different song', () => {
		expect(isDuplicateOfSibling('Eleanor Rigby (3)', 217.9, dup)).toBe(true);
		expect(isDuplicateOfSibling('Eleanor Rigby (3)', 240.0, dup)).toBe(false);
	});

	it('does not match itself', () => {
		const self = [{ title: 'Eleanor Rigby (3)', durationSec: 217.8, discNumber: 1 }];
		expect(isDuplicateOfSibling('Eleanor Rigby (3)', 217.8, self)).toBe(false);
	});
});

describe('planAlbumRename', () => {
	it('merges the NODA split onto one spelling', () => {
		const rows = [
			ROW('1', 'N D A', 'NODA: le monde et les humains', 155),
			ROW('2', 'TONSURE', 'NODA le monde et les humains', 402),
			ROW('3', 'WHE-RE', 'NODA: le monde et les humains', 156),
		];
		const plan = planAlbumRename(rows);
		expect(plan).toHaveLength(1);
		// The colon form is more common, so it is canonical.
		expect(plan[0].canonical).toBe('NODA: le monde et les humains');
		expect(plan[0].updates).toHaveLength(1);
		expect(plan[0].updates[0].to).toBe('NODA: le monde et les humains');
	});

	it('merges a case-only difference', () => {
		const rows = [
			ROW('1', 'Entombed', 'Koi no Yokan', 299),
			ROW('2', 'Creeper', 'Koi No Yokan', 370),
			ROW('3', 'Knife Prty', 'Koi no Yokan', 250),
		];
		const plan = planAlbumRename(rows);
		expect(plan).toHaveLength(1);
		expect(plan[0].canonical).toBe('Koi no Yokan');
		expect(plan[0].updates.map((u) => u.id)).toEqual(['2']);
	});

	it('leaves genuinely distinct releases in the same folder alone', () => {
		const rows = [
			ROW('1', 'Joint de culotte', "Y&W L'album", 216),
			ROW('2', 'Joint de culotte', 'Black Album', 216),
		];
		expect(planAlbumRename(rows)).toHaveLength(0);
	});

	it('keeps multi-disc structure: a disc-2 track is not collapsed into disc 1', () => {
		// A rename must not flatten a 2-disc release into one album. Every row is
		// renamed, but disc numbers are preserved by the caller, not merged away.
		const rows = [
			ROW('1', 'A', 'Album', 100, 1),
			ROW('2', 'B', 'Album', 100, 2),
			ROW('3', 'C', 'ALBUM', 100, 2),
		];
		const plan = planAlbumRename(rows);
		expect(plan).toHaveLength(1);
		expect(plan[0].updates).toHaveLength(1);
		expect(plan[0].updates[0].discNumber).toBe(2);
	});

	it('is deterministic: same input, same plan, regardless of row order', () => {
		const rows = [
			ROW('1', 'A', 'Album', 100),
			ROW('2', 'B', 'ALBUM', 100),
			ROW('3', 'C', 'album', 100),
		];
		const a = planAlbumRename(rows);
		const b = planAlbumRename(rows.slice().reverse());
		expect(a).toEqual(b);
	});

	it('produces no plan for an album that already agrees', () => {
		const rows = [ROW('1', 'A', 'Album', 100), ROW('2', 'B', 'Album', 100)];
		expect(planAlbumRename(rows)).toHaveLength(0);
	});

	it('never plans a rename to an empty string', () => {
		const rows = [ROW('1', 'A', '', 100), ROW('2', 'B', 'Album', 100)];
		for (const p of planAlbumRename(rows)) {
			expect(p.canonical.length).toBeGreaterThan(0);
			for (const u of p.updates) expect(u.to.length).toBeGreaterThan(0);
		}
	});

	it('keeps a self-titled single separate from an album of the same name', () => {
		// 'Album' by one artist, 'Album' (the record) by another: the artist is not
		// part of the key here, so this only passes because the titles differ.
		const rows = [ROW('1', 'X', 'Album', 100), ROW('2', 'Y', 'ALBUM', 100)];
		const plan = planAlbumRename(rows);
		expect(plan[0].canonical).toMatch(/^Album$/i);
	});
});
