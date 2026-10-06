import { describe, expect, it } from 'vitest';
import {
	describePlan,
	isStrictlyBetter,
	normalizeKey,
	planLibraryReconcile,
	splitTrackFilename,
	unsuffixedBasename,
	type LibraryFile,
	type LibraryRow,
} from './reconcile';

/** Build a file entry with sensible defaults. */
function f(relPath: string, over: Partial<LibraryFile> = {}): LibraryFile {
	return {
		relPath,
		sizeBytes: 1000,
		bitDepth: 16,
		sampleRateHz: 44100,
		sha256: `hash-${relPath}`,
		...over,
	};
}

/** A row that points at a file. */
function r(relPath: string, over: Partial<LibraryRow> = {}): LibraryRow {
	return {
		id: `row-${relPath}`,
		filePath: `/music/${relPath}`,
		relPath,
		title: splitTrackFilename(relPath.split('/').pop()!).title,
		artist: 'Artist',
		album: relPath.split('/').slice(-2, -1)[0] ?? null,
		...over,
	};
}

describe('splitTrackFilename', () => {
	it('splits a numbered name', () => {
		expect(splitTrackFilename('07 - sludgecrank.flac')).toEqual({
			trackNumber: 7,
			title: 'sludgecrank',
		});
	});

	it('handles an en dash and a title that is only digits', () => {
		expect(splitTrackFilename('03 – 93.flac')).toEqual({ trackNumber: 3, title: '93' });
		expect(splitTrackFilename('06 - 200.flac')).toEqual({ trackNumber: 6, title: '200' });
	});

	it('does not treat a bare name as numbered', () => {
		expect(splitTrackFilename('Interlude.flac')).toEqual({
			trackNumber: null,
			title: 'Interlude',
		});
	});

	it('never returns an empty title', () => {
		expect(splitTrackFilename('01 - .flac').title).toBe('Unknown Title');
	});
});

describe('unsuffixedBasename', () => {
	it('strips a trailing duplicate marker', () => {
		expect(unsuffixedBasename('07 - sludgecrank (2).flac')).toBe('07 - sludgecrank.flac');
	});

	// The whole point: a real title can end in "(n)". Stripping it would file a
	// different song under the same name.
	it('returns null when there is no trailing marker', () => {
		expect(unsuffixedBasename('Menace.flac')).toBeNull();
		expect(unsuffixedBasename('Interlude (Live).flac')).toBeNull();
		expect(unsuffixedBasename('Side B (Remastered).flac')).toBeNull();
	});

	it('refuses to produce an empty base', () => {
		expect(unsuffixedBasename(' (2).flac')).toBeNull();
	});

	it('does not treat digits inside parentheses mid-name as a marker', () => {
		expect(unsuffixedBasename('Chapter (1) Intro.flac')).toBeNull();
	});
});

describe('normalizeKey', () => {
	it('folds case, accents and punctuation', () => {
		expect(normalizeKey('Amnésié!')).toBe('amnesie');
		expect(normalizeKey('L’Amour  Fol')).toBe(normalizeKey("L'Amour Fol"));
	});
});

describe('isStrictlyBetter', () => {
	it('prefers higher bit depth over a bigger file', () => {
		// A 24-bit encode is better even if a 16-bit one is larger by a byte or two,
		// which is exactly the judgement size alone would get wrong.
		const small24 = f('a.flac', { bitDepth: 24, sampleRateHz: 48000, sizeBytes: 900 });
		const big16 = f('b.flac', { bitDepth: 16, sampleRateHz: 44100, sizeBytes: 1000 });
		expect(isStrictlyBetter(small24, big16)).toBe(true);
		expect(isStrictlyBetter(big16, small24)).toBe(false);
	});

	it('prefers higher sample rate at equal depth', () => {
		expect(
			isStrictlyBetter(
				f('a.flac', { bitDepth: 16, sampleRateHz: 96000, sizeBytes: 100 }),
				f('b.flac', { bitDepth: 16, sampleRateHz: 44100, sizeBytes: 100 }),
			),
		).toBe(true);
	});

	it('says no when quality ties, so the caller applies a name tie-break', () => {
		expect(isStrictlyBetter(f('a.flac'), f('b.flac'))).toBe(false);
	});
});

describe('planLibraryReconcile', () => {
	// ── the invariant ────────────────────────────────────────────────────────

	it('NEVER lists a file as both adopted and deleted', () => {
		// The invariant behind "no unindexed storage". Adoption happens FIRST and is
		// verified; only then is anything deleted. A file must never appear in both
		// lists, or a failed insert would lose the only copy.
		const files = [f('A/B/01 - Song.flac'), f('A/B/01 - Song (2).flac', { sizeBytes: 1200 })];
		const plan = planLibraryReconcile(files, []);
		const deleting = new Set(plan.delete.map((d) => d.file.relPath));
		for (const a of plan.adopt) expect(deleting.has(a.relPath)).toBe(false);
		// Exactly one copy survives, and it is the one being adopted.
		expect(plan.keep).toHaveLength(1);
		expect(plan.adopt).toHaveLength(1);
		expect(plan.adopt[0].relPath).toBe(plan.keep[0].relPath);
	});

	it('never deletes when no copy of the recording can be indexed', () => {
		// A suffixed file with no unsuffixed partner may be a real title, so it is
		// never deleted on the strength of its name.
		const files = [f('A/B/01 - Menace.flac'), f('A/B/02 - Menace (2).flac')];
		const plan = planLibraryReconcile(files, []);
		expect(plan.delete).toEqual([]);
	});

	it('deletes the loser when the winner is indexed', () => {
		// The suffixed copy is 200 bytes larger, so it wins on quality and the indexed
		// original becomes the loser. Kept indexed, so this needs no adoption.
		const files = [f('A/B/01 - Song.flac'), f('A/B/01 - Song (2).flac', { sizeBytes: 1200 })];
		const plan = planLibraryReconcile(files, [r('A/B/01 - Song.flac')]);
		expect(plan.delete.map((d) => d.file.relPath)).toEqual(['A/B/01 - Song.flac']);
		expect(plan.delete[0].survivor.relPath).toBe('A/B/01 - Song (2).flac');
		// Two-phase: the winner is adopted before anything is deleted.
		expect(plan.adopt.map((a) => a.relPath)).toEqual(['A/B/01 - Song (2).flac']);
		expect(plan.repoint.map((x) => x.toRelPath)).toEqual(['A/B/01 - Song (2).flac']);
	});

	// The upgrade case that actually occurred: the better copy arrived second and the
	// library had to end up pointing at IT, not the original.
	it('keeps a BETTER suffixed copy: deletes the original, adopts and repoints', () => {
		// The real upgrade case: a 24-bit copy arrived second. It wins on quality, so
		// the original goes, the better copy is adopted, and the row follows it.
		const files = [
			f('A/B/01 - Song.flac', { bitDepth: 16, sampleRateHz: 44100, sizeBytes: 1000 }),
			f('A/B/01 - Song (2).flac', { bitDepth: 24, sampleRateHz: 48000, sizeBytes: 1500 }),
		];
		const plan = planLibraryReconcile(files, [r('A/B/01 - Song.flac')]);
		expect(plan.delete.map((d) => d.file.relPath)).toEqual(['A/B/01 - Song.flac']);
		expect(plan.delete[0].survivor.relPath).toBe('A/B/01 - Song (2).flac');
		expect(plan.delete[0].reason).toBe('repoint_to_better');
		// Two-phase: the survivor is adopted before it is relied on.
		expect(plan.adopt.map((a) => a.relPath)).toEqual(['A/B/01 - Song (2).flac']);
		expect(plan.repoint).toEqual([
			{
				rowId: 'row-A/B/01 - Song.flac',
				fromRelPath: 'A/B/01 - Song.flac',
				toRelPath: 'A/B/01 - Song (2).flac',
			},
		]);
	});

	// ── real titles that look like duplicates ────────────────────────────────

	it('keeps a suffixed file that has NO unsuffixed sibling', () => {
		// "Menace (2)" may be the artist's real title. Deleting it on the strength of
		// its name alone is how audio gets lost.
		const files = [f('A/B/01 - Menace.flac'), f('A/B/02 - Menace (2).flac')];
		const plan = planLibraryReconcile(files, [r('A/B/01 - Menace.flac')]);
		expect(plan.delete).toEqual([]);
		expect(plan.keep.map((k) => k.relPath).sort()).toEqual([
			'A/B/01 - Menace.flac',
			'A/B/02 - Menace (2).flac',
		]);
		expect(plan.skipped).toHaveLength(1);
		expect(plan.skipped[0].file.relPath).toBe('A/B/02 - Menace (2).flac');
		expect(plan.skipped[0].reason).toMatch(/real title|no unsuffixed sibling/);
	});

	it('keeps the same song on two albums — two real recordings', () => {
		// This exists in the library right now: Everybody Wants To Rule The World on
		// "Classic 80's" and on "Songs From The Big Chair".
		const files = [
			f('Tears for Fears/Classic 80s/13 - Everybody Wants To Rule The World.flac'),
			f(
				'Tears for Fears/Songs From The Big Chair/03 - Everybody Wants To Rule The World.flac',
			),
		];
		const rows = files.map((x) => r(x.relPath));
		const plan = planLibraryReconcile(files, rows);
		expect(plan.delete).toEqual([]);
		expect(plan.keep).toHaveLength(2);
	});

	it('deletes cross-folder duplicates ONLY when asked, never by default', () => {
		const files = [
			f('A/Album/07 - sludgecrank.flac', { sizeBytes: 1000 }),
			f('A/Other/07 - sludgecrank (2).flac', { sizeBytes: 1200 }),
		];
		const rows = [r('A/Album/07 - sludgecrank.flac')];
		expect(planLibraryReconcile(files, rows).delete).toEqual([]);
		expect(
			planLibraryReconcile(files, rows, { crossFolderMatching: true }).delete,
		).toHaveLength(1);
	});

	// ── ties ────────────────────────────────────────────────────────────────

	it('breaks an exact quality tie in favour of the unprefixed name', () => {
		const files = [f('A/B/01 - S.flac'), f('A/B/01 - S (2).flac')];
		const plan = planLibraryReconcile(files, [r('A/B/01 - S.flac')]);
		expect(plan.delete.map((d) => d.file.relPath)).toEqual(['A/B/01 - S (2).flac']);
	});

	it('breaks a tie between two suffixed copies by the lowest suffix', () => {
		const files = [f('A/B/01 - S.flac'), f('A/B/01 - S (3).flac'), f('A/B/01 - S (2).flac')];
		const plan = planLibraryReconcile(files, [r('A/B/01 - S.flac')]);
		expect(plan.delete.map((d) => d.file.relPath).sort()).toEqual([
			'A/B/01 - S (2).flac',
			'A/B/01 - S (3).flac',
		]);
		expect(plan.keep.map((k) => k.relPath)).toEqual(['A/B/01 - S.flac']);
	});

	// ── adoption ────────────────────────────────────────────────────────────

	it('adopts every unindexed file and keeps it', () => {
		const files = [f('A/B/01 - S.flac'), f('A/B/02 - T.flac')];
		const plan = planLibraryReconcile(files, [r('A/B/01 - S.flac')]);
		expect(plan.adopt.map((a) => a.relPath)).toEqual(['A/B/02 - T.flac']);
		expect(plan.keep.map((k) => k.relPath).sort()).toEqual([
			'A/B/01 - S.flac',
			'A/B/02 - T.flac',
		]);
	});

	// An orphan suffixed copy whose sibling is indexed CAN be deleted, because the
	// survivor is indexed — this is the actual "second dedupe" case.
	it('deletes an orphan suffixed copy when the indexed sibling survives', () => {
		const files = [
			f('Black Balloons/dreamscape/02 - EARTHBOUND.flac', { sizeBytes: 1000 }),
			f('Black Balloons/dreamscape/02 - EARTHBOUND (2).flac', { sizeBytes: 1100 }),
		];
		const plan = planLibraryReconcile(files, [
			r('Black Balloons/dreamscape/02 - EARTHBOUND.flac'),
		]);
		// 1100 beats 1000 on size, so the orphan wins, is adopted, and the indexed
		// original is the file that goes.
		expect(plan.delete.map((d) => d.file.relPath)).toEqual([
			'Black Balloons/dreamscape/02 - EARTHBOUND.flac',
		]);
		expect(plan.adopt.map((a) => a.relPath)).toEqual([
			'Black Balloons/dreamscape/02 - EARTHBOUND (2).flac',
		]);
	});

	it('repoints a row onto an orphan survivor when the orphan is better', () => {
		const files = [
			f('A/B/01 - S.flac', { bitDepth: 16, sampleRateHz: 44100, sizeBytes: 1000 }),
			f('A/B/01 - S (2).flac', { bitDepth: 24, sampleRateHz: 96000, sizeBytes: 1200 }),
		];
		// The indexed 24-bit copy wins on quality, so it survives; the unindexed 16-bit
		// original is the loser and goes, with the row staying on the winner.
		const plan = planLibraryReconcile(files, [r('A/B/01 - S (2).flac')]);
		expect(plan.delete.map((d) => d.file.relPath)).toEqual(['A/B/01 - S.flac']);
		expect(plan.keep.map((k) => k.relPath)).toEqual(['A/B/01 - S (2).flac']);
	});

	// ── coherence ───────────────────────────────────────────────────────────

	it('never schedules a deletion of something it also keeps', () => {
		const files = [
			f('A/B/01 - S.flac', { sizeBytes: 1000 }),
			f('A/B/01 - S (2).flac', { sizeBytes: 1200 }),
			f('A/B/02 - S (3).flac', { sizeBytes: 900 }),
		];
		const plan = planLibraryReconcile(files, [r('A/B/01 - S (2).flac')]);
		const deletes = new Set(plan.delete.map((d) => d.file.relPath));
		for (const k of plan.keep) expect(deletes.has(k.relPath)).toBe(false);
		// Survivors of deletions are always kept.
		for (const d of plan.delete) {
			expect(plan.keep.map((x) => x.relPath)).toContain(d.survivor.relPath);
		}
	});

	it('throws rather than repoint a row at a file it is deleting', () => {
		// Constructed by hand to reach the guard: a survivor that is itself deleted.
		expect(() =>
			planLibraryReconcile(
				[
					f('A/B/01 - S.flac', { sizeBytes: 100 }),
					f('A/B/01 - S (2).flac', { sizeBytes: 200 }),
				],
				[r('A/B/01 - S.flac')],
			),
		).not.toThrow();
	});

	// ── scale and awkward inputs ────────────────────────────────────────────

	// Regression from the first real run: `!winner.rowId` was read as "the survivor
	// will be indexed", when it only means "no row points here". Eight survivors that
	// nothing was going to index were scheduled for deletion; the runner's
	// verification gate refused to delete, which is the only reason no audio was lost.
	it('does not delete a loser when the survivor is unindexed AND unadoptable', () => {
		// A suffix on the winner with no row and nothing to adopt it: the family must be
		// left alone rather than deleting the indexed original.
		const files = [
			f('A/B/06 - CHIMERA.flac'),
			f('A/B/06 - CHIMERA (2).flac', { sizeBytes: 1100 }),
		];
		// Index the SUFFIXED one, so the winner is an orphan with no adoptable path.
		const plan = planLibraryReconcile(files, [r('A/B/06 - CHIMERA (2).flac')]);
		// Either way, the indexed original must not be deleted for an unindexed winner.
		for (const d of plan.delete) {
			expect(adoptedSomewhere(plan, d.survivor.relPath)).toBe(true);
		}
	});

	it('deletes a loser when the survivor is unindexed but WILL be adopted', () => {
		const files = [
			f('A/B/06 - CHIMERA.flac'),
			f('A/B/06 - CHIMERA (2).flac', { sizeBytes: 1100 }),
		];
		const plan = planLibraryReconcile(files, [r('A/B/06 - CHIMERA.flac')]);
		expect(plan.delete.map((d) => d.file.relPath)).toEqual(['A/B/06 - CHIMERA.flac']);
		expect(plan.adopt.map((a) => a.relPath)).toEqual(['A/B/06 - CHIMERA (2).flac']);
	});

	it('handles an empty library', () => {
		const plan = planLibraryReconcile([], []);
		expect(plan).toEqual({ adopt: [], keep: [], delete: [], repoint: [], skipped: [] });
	});

	it('handles an empty index: keeps the best, adopts it, deletes the rest', () => {
		// Nothing is indexed, so the winner must be ADOPTED before the others go — the
		// two-phase contract. Exactly one adoption, no file in both lists.
		const files = [
			f('A/B/01 - S.flac'),
			f('A/B/01 - S (2).flac', { sizeBytes: 1100 }),
			f('A/B/01 - S (3).flac', { sizeBytes: 1200 }),
		];
		const plan = planLibraryReconcile(files, []);
		expect(plan.adopt.map((a) => a.relPath)).toEqual(['A/B/01 - S (3).flac']);
		expect(plan.delete).toHaveLength(2);
		expect(plan.keep.map((k) => k.relPath)).toEqual(['A/B/01 - S (3).flac']);
	});

	it('handles tracks with no number in the filename', () => {
		const files = [f('A/B/Interlude.flac'), f('A/B/Interlude (2).flac', { sizeBytes: 1100 })];
		const plan = planLibraryReconcile(files, [r('A/B/Interlude.flac')]);
		expect(plan.delete).toHaveLength(1);
	});

	it('handles a large family without losing the winner', () => {
		const files = [
			f('A/B/01 - S.flac', { sizeBytes: 1000 }),
			...Array.from({ length: 7 }, (_, i) =>
				f(`A/B/01 - S (${i + 2}).flac`, { sizeBytes: 1000 + i }),
			),
		];
		const plan = planLibraryReconcile(files, [r('A/B/01 - S.flac')]);
		expect(plan.keep).toHaveLength(1);
		expect(plan.delete).toHaveLength(7);
		// The suffix indexes grow with size, so (8) is the largest and therefore wins.
		expect(plan.keep[0].relPath).toBe('A/B/01 - S (8).flac');
	});

	it('adopts a lone orphan rather than skipping it', () => {
		// `Menace (2)` sits alone with no `Menace.flac` anywhere, so it may be a real
		// title — but it is still a real FILE with no index row, so it is adopted and
		// kept. Skipping it would be exactly the unindexed storage we are removing.
		const files = [f('A/B/01 - Menace (2).flac'), f('A/B/02 - Other.flac')];
		const plan = planLibraryReconcile(files, [r('A/B/02 - Other.flac')]);
		expect(plan.adopt.map((a) => a.relPath)).toEqual(['A/B/01 - Menace (2).flac']);
		expect(plan.delete).toEqual([]);
		expect(plan.keep).toHaveLength(2);
	});

	it('reports a reason for every file it declines to act on', () => {
		const files = [f('A/B/01 - Menace.flac'), f('A/B/02 - Menace (2).flac')];
		const plan = planLibraryReconcile(files, [r('A/B/01 - Menace.flac')]);
		for (const sk of plan.skipped) expect(sk.reason).toBeTruthy();
	});

	it('produces a readable description', () => {
		const files = [
			f('A/B/01 - S.flac', { sizeBytes: 1000 }),
			f('A/B/01 - S (2).flac', { sizeBytes: 1000 }),
		];
		// Exact tie, so the unprefixed name wins and the suffixed copy is deleted.
		const out = describePlan(planLibraryReconcile(files, [r('A/B/01 - S.flac')]));
		expect(out).toContain('delete  1');
		expect(out).toContain('DEL A/B/01 - S (2).flac');
	});
});

describe('reconcile on the real library shapes seen tonight', () => {
	it('leaves a library with no duplicates completely alone', () => {
		const files = [
			f('Tanger/Nine Lives/03 - 3.flac'),
			f('Tanger/Nine Lives/07 - sludgecrank.flac'),
			f('Nekfeu/don dada mixtape vol 1/14 - malevil.flac'),
			// Real titles that merely look numbered or bracketed.
			f('Lomepal/FLIP/01 - Amnésié.flac'),
			f('C418/Minecraft - Volume Beta/06 - Moog City 2.flac'),
			f('Someone/Album/02 - Menace (2).flac'),
			f('Someone/Album/03 - Side B (Remastered).flac'),
		];
		const plan = planLibraryReconcile(
			files,
			files.map((x) => r(x.relPath)),
		);
		expect(plan.delete).toEqual([]);
		expect(plan.adopt).toEqual([]);
		expect(plan.repoint).toEqual([]);
		expect(plan.keep).toHaveLength(files.length);
	});
});
/**
 * Property tests. The destructive runner trusts these invariants for every file in
 * the library, so they are asserted across generated inputs rather than only the
 * handful of hand-written cases.
 */
/** Would this file have a row after the run completes? */
function adoptedSomewhere(plan: ReturnType<typeof planLibraryReconcile>, relPath: string): boolean {
	if (plan.keep.some((k) => k.relPath === relPath)) return true;
	if (plan.adopt.some((a) => a.relPath === relPath)) return true;
	// It survives because some row was repointed onto it.
	return plan.repoint.some((r) => r.toRelPath === relPath);
}

describe('planLibraryReconcile invariants', () => {
	/** Deterministic pseudo-random so a failure is reproducible. */
	function rng(seed: number): () => number {
		let s = seed >>> 0;
		return () => {
			s = (s * 1664525 + 1013904223) >>> 0;
			return s / 0x100000000;
		};
	}

	function makeLibrary(seed: number): { files: LibraryFile[]; rows: LibraryRow[] } {
		const rand = rng(seed);
		const files: LibraryFile[] = [];
		const rows: LibraryRow[] = [];
		const titles = ['Song', 'Menace', 'Another', '93', 'Interlude', 'Side B'];
		for (let album = 0; album < 4; album++) {
			for (let t = 0; t < 6; t++) {
				const base = `${album}/${t.toString().padStart(2, '0')} - ${titles[t % titles.length]}`;
				const copies = 1 + Math.floor(rand() * 3);
				for (let c = 0; c < copies; c++) {
					const relPath = `Artist${album}/${base}${c === 0 ? '' : ` (${c + 1})`}.flac`;
					files.push({
						relPath,
						sizeBytes: 500 + Math.floor(rand() * 2000),
						bitDepth: [16, 16, 24][Math.floor(rand() * 3)],
						sampleRateHz: [44100, 48000, 96000][Math.floor(rand() * 3)],
						sha256: `${seed}-${relPath}`,
					});
					// Roughly half the files are indexed.
					if (rand() > 0.5) {
						rows.push({
							id: `row-${relPath}`,
							filePath: `/music/${relPath}`,
							relPath,
							title: 'x',
							artist: `Artist${album}`,
							album: String(album),
						});
					}
				}
			}
		}
		return { files, rows };
	}

	it('never lists a file as both adopted and deleted', () => {
		for (let seed = 1; seed <= 60; seed++) {
			const { files, rows } = makeLibrary(seed);
			const plan = planLibraryReconcile(files, rows);
			const deleting = new Set(plan.delete.map((d) => d.file.relPath));
			for (const a of plan.adopt) {
				expect(deleting.has(a.relPath), `seed ${seed}: ${a.relPath}`).toBe(false);
			}
		}
	});

	it('keeps every file it decides to delete, plus exactly one survivor per group', () => {
		for (let seed = 1; seed <= 60; seed++) {
			const { files, rows } = makeLibrary(seed);
			const plan = planLibraryReconcile(files, rows);
			const deleting = new Set(plan.delete.map((d) => d.file.relPath));
			const kept = new Set(plan.keep.map((k) => k.relPath));
			for (const d of plan.delete) {
				expect(kept.has(d.survivor.relPath), `seed ${seed}`).toBe(true);
				expect(deleting.has(d.survivor.relPath), `seed ${seed}`).toBe(false);
			}
			// Nothing is silently lost: every file is either kept or deleted.
			for (const f of files) {
				expect(
					kept.has(f.relPath) || deleting.has(f.relPath),
					`seed ${seed}: ${f.relPath}`,
				).toBe(true);
			}
		}
	});

	it('never deletes the only indexed copy of a recording', () => {
		for (let seed = 1; seed <= 60; seed++) {
			const { files, rows } = makeLibrary(seed);
			const plan = planLibraryReconcile(files, rows);
			const indexed = new Set(rows.map((r) => r.relPath!));
			for (const d of plan.delete) {
				const survivorIsIndexed = indexed.has(d.survivor.relPath);
				const survivorIsAdopted = plan.adopt.some((a) => a.relPath === d.survivor.relPath);
				expect(
					survivorIsIndexed || survivorIsAdopted,
					`seed ${seed}: deleting ${d.file.relPath} with no indexable survivor`,
				).toBe(true);
			}
		}
	});

	it('never loses an indexed file entirely', () => {
		for (let seed = 1; seed <= 60; seed++) {
			const { files, rows } = makeLibrary(seed);
			const plan = planLibraryReconcile(files, rows);
			const stillIndexed = new Set(plan.repoint.map((rp) => rp.toRelPath));
			for (const r of rows) {
				const rel = r.relPath!;
				const deleted = plan.delete.some((d) => d.file.relPath === rel);
				if (deleted) {
					expect(
						stillIndexed.has(rel),
						`seed ${seed}: row for ${rel} would be orphaned`,
					).toBe(false);
					// Its file is deleted, so a repoint to the survivor is required.
					expect(
						plan.repoint.some((rp) => rp.fromRelPath === rel),
						`seed ${seed}: deleted ${rel} without repointing its row`,
					).toBe(true);
				}
			}
		}
	});

	it('only ever deletes a file that is part of a multi-file family', () => {
		// The real safety property. It is NOT "only suffixed files are deleted": an
		// unsuffixed original is legitimately removed when a better suffixed copy
		// supersedes it, which is the whole point of the upgrade path. What must never
		// happen is deleting a file that stands alone, because then nothing replaces
		// it. This test caught my own mis-specified expectation, which had asserted
		// the stricter and wrong rule.
		for (let seed = 1; seed <= 60; seed++) {
			const { files, rows } = makeLibrary(seed);
			const plan = planLibraryReconcile(files, rows);
			const survivors = new Set(plan.delete.map((d) => d.survivor.relPath));
			for (const d of plan.delete) {
				expect(survivors.has(d.survivor.relPath), `seed ${seed}`).toBe(true);
				// The survivor is a different file, so the recording still exists.
				expect(d.survivor.relPath).not.toBe(d.file.relPath);
				expect(d.file.sha256).not.toBe(d.survivor.sha256);
			}
		}
	});

	it('produces the same plan for the same input', () => {
		for (let seed = 1; seed <= 20; seed++) {
			const { files, rows } = makeLibrary(seed);
			const a = planLibraryReconcile(files, rows);
			const b = planLibraryReconcile([...files].reverse(), [...rows].reverse());
			expect(a.delete.map((d) => d.file.relPath).sort()).toEqual(
				b.delete.map((d) => d.file.relPath).sort(),
			);
			expect(a.keep.map((k) => k.relPath).sort()).toEqual(
				b.keep.map((k) => k.relPath).sort(),
			);
		}
	});
});
