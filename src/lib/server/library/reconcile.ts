/**
 * Library reconcile planner — PURE. No filesystem, no database.
 *
 * Decides, for a whole library at once, what should be adopted, kept, repointed and
 * deleted. The destructive half of the tool is a thin shell around this file, so the
 * rules that can lose audio are unit-tested rather than exercised on the real
 * library for the first time during a delete.
 *
 * ## The rule that matters
 *
 * **A file may only be deleted when its surviving counterpart is indexed, or is
 * being adopted in the same run.** That is the invariant behind "no more fully
 * unindexed storage": there is never a moment where a recording exists only as an
 * orphan on disk. Every other rule here is a detail of that one.
 *
 * ## Why grouping is delicate
 *
 * Grouping by artist+title alone is wrong: "Everybody Wants To Rule The World" by
 * Tears for Fears is legitimately on two albums (`Classic 80's` and `Songs From
 * The Big Chair`) and deleting one loses a real recording. Grouping by directory
 * misses the actual orphans, which sit in a different folder from their sibling.
 *
 * So a "same recording" group is: same artist, same title, same album. Suffixed
 * files are then resolved WITHIN that group by quality. A suffixed file with no
 * unsuffixed partner anywhere is left strictly alone — `Menace (2)` may be the
 * artist's real title, and guessing is how the first dedupe nearly cost audio.
 */

export interface LibraryFile {
	/** Library-relative path, e.g. `Artist/Album/01 - Title.flac`. */
	relPath: string;
	sizeBytes: number;
	bitDepth: number | null;
	sampleRateHz: number | null;
	sha256: string;
}

export interface LibraryRow {
	id: string;
	/** Absolute path as stored, or null when the row owns no file. */
	filePath: string | null;
	/** Path relative to the library root, for matching. */
	relPath: string | null;
	title: string;
	artist: string;
	album: string | null;
}

/**
 * Split "01 - Title.flac" into its number and title.
 *
 * The extension is stripped FIRST. Deriving the title with ".flac" still attached
 * made `Song.flac` and `Song (2).flac` different identities, so every duplicate
 * landed in its own group and the reconciler found nothing to do — a silent
 * no-op that looks exactly like "there are no duplicates".
 */
export function splitTrackFilename(basename: string): {
	trackNumber: number | null;
	title: string;
} {
	const dot = basename.lastIndexOf('.');
	const stem = dot > 0 ? basename.slice(0, dot) : basename;
	const m = /^(\d{1,3})\s*[-–—]\s*(.+)$/.exec(stem);
	if (!m) return { trackNumber: null, title: stem.trim() || 'Unknown Title' };
	const n = Number.parseInt(m[1], 10);
	return {
		trackNumber: Number.isFinite(n) ? n : null,
		title: m[2].trim() || 'Unknown Title',
	};
}

/**
 * The un-suffixed name for a file, or null when it has no "(n)".
 *
 * "(2)" is a duplicate marker. A real title can also contain it — "Menace (2)",
 * "Side B (Remastered)" — so this only strips a TRAILING "(digits)" immediately
 * before the extension.
 */
export function unsuffixedBasename(basename: string): string | null {
	const dot = basename.lastIndexOf('.');
	const stem = dot > 0 ? basename.slice(0, dot) : basename;
	const ext = dot > 0 ? basename.slice(dot) : '';
	const m = /^(.*) \((\d+)\)$/.exec(stem);
	if (!m) return null;
	const base = m[1];
	if (!base.trim()) return null;
	return `${base}${ext}`;
}

export const SUFFIXED_FILE_RE = /^(.*) \((\d+)\)([^/]*)$/;

/** Case- and accent-insensitive, punctuation-collapsed comparison key. */
export function normalizeKey(value: string | null | undefined): string {
	return String(value ?? '')
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

export interface Candidate {
	file: LibraryFile;
	/** Directory part of relPath, with trailing slash. */
	dir: string;
	basename: string;
	suffixed: boolean;
	suffixIndex: number;
	trackNumber: number | null;
	title: string;
	/**
	 * Title with any trailing "(n)" removed — the identity used for grouping.
	 *
	 * Without this, `Song.flac` and `Song (2).flac` have different titles and land in
	 * different groups, so the reconciler groups nothing and reports nothing.
	 */
	groupTitle: string;
	/** True when a sibling with the unsuffixed name exists in the SAME directory. */
	hasUnsuffixedSibling: boolean;
	/** Whether some database row already points at this file. */
	indexed: boolean;
	rowId: string | null;
}

/** Ranking: higher is better. Bit depth dominates, then rate, then size. */
export function qualityRank(f: LibraryFile): number[] {
	return [f.bitDepth ?? 0, f.sampleRateHz ?? 0, f.sizeBytes];
}

/** Strictly better than `a`? Unambiguous only — ties fall back to the name. */
export function isStrictlyBetter(a: LibraryFile, b: LibraryFile): boolean {
	const ra = qualityRank(a);
	const rb = qualityRank(b);
	for (let i = 0; i < ra.length; i++) {
		if (ra[i] !== rb[i]) return ra[i] > rb[i];
	}
	return false;
}

export interface DeleteDecision {
	/** The file to remove. */
	file: LibraryFile;
	/** The file that takes its place in the library. */
	survivor: LibraryFile;
	reason: 'duplicate_of_sibling' | 'repoint_to_better';
	/** The row that pointed at the deleted file, if any. */
	rowId: string | null;
}

export interface RepointDecision {
	rowId: string;
	fromRelPath: string;
	toRelPath: string;
}

export interface ReconcilePlan {
	/** Files on disk that no row points at. Safe to insert as new rows. */
	adopt: LibraryFile[];
	/** One file per recording: the one that stays. */
	keep: LibraryFile[];
	delete: DeleteDecision[];
	/** Rows whose file_path must change to the surviving file. */
	repoint: RepointDecision[];
	/**
	 * Files deliberately NOT acted on, with why. Surfaced in the report so a file is
	 * never quietly ignored — a silent skip is indistinguishable from a bug.
	 */
	skipped: Array<{ file: LibraryFile; reason: string }>;
}

export interface PlanOptions {
	/** Treat these as the same recording even across directories. Off by default. */
	crossFolderMatching?: boolean;
}

function basenameOf(relPath: string): string {
	const i = relPath.lastIndexOf('/');
	return i >= 0 ? relPath.slice(i + 1) : relPath;
}

function dirOf(relPath: string): string {
	const i = relPath.lastIndexOf('/');
	return i >= 0 ? relPath.slice(0, i + 1) : '';
}

/**
 * Build the plan. Pure: the caller supplies the inventory and the index state.
 */
export function planLibraryReconcile(
	files: LibraryFile[],
	rows: LibraryRow[],
	options: PlanOptions = {},
): ReconcilePlan {
	// ── index state ────────────────────────────────────────────────────────
	const rowByRel = new Map<string, LibraryRow>();
	for (const r of rows) {
		if (r.relPath) rowByRel.set(r.relPath, r);
	}
	// The set of unsuffixed basenames that exist, per directory, for sibling checks.
	const basenamesByDir = new Map<string, Set<string>>();
	for (const f of files) {
		const d = dirOf(f.relPath);
		const set = basenamesByDir.get(d) ?? new Set<string>();
		set.add(basenameOf(f.relPath));
		basenamesByDir.set(d, set);
	}

	// Titles of every file that is NOT suffixed, for cross-folder sibling checks.
	const groupTitlesAnywhere = new Set<string>();
	for (const f of files) {
		const base = basenameOf(f.relPath);
		if (unsuffixedBasename(base) === null) {
			groupTitlesAnywhere.add(normalizeKey(splitTrackFilename(base).title));
		}
	}

	const candidates: Candidate[] = files.map((file) => {
		const basename = basenameOf(file.relPath);
		const dir = dirOf(file.relPath);
		const m = SUFFIXED_FILE_RE.exec(basename);
		const { trackNumber, title } = splitTrackFilename(basename);
		const unsuffixed = unsuffixedBasename(basename);
		const row = rowByRel.get(file.relPath) ?? null;
		const groupStem = unsuffixedBasename(basename) ?? basename;
		const groupTitle = splitTrackFilename(groupStem).title;
		return {
			file,
			dir,
			basename,
			suffixed: m !== null,
			suffixIndex: m ? Number(m[2]) : 1,
			trackNumber,
			title,
			groupTitle,
			hasUnsuffixedSibling:
				unsuffixed !== null &&
				(options.crossFolderMatching
					? groupTitlesAnywhere.has(normalizeKey(groupTitle))
					: (basenamesByDir.get(dir)?.has(unsuffixed) ?? false)),
			indexed: row !== null,
			rowId: row?.id ?? null,
		};
	});

	// ── adoption: anything on disk with no row ─────────────────────────────
	const adopt = candidates.filter((c) => !c.indexed).map((c) => c.file);

	// ── group by recording ─────────────────────────────────────────────────
	// artist + title + album. Album is part of the key because the same song on two
	// albums is two real recordings.
	const groups = new Map<string, Candidate[]>();
	for (const c of candidates) {
		// Cross-folder mode must NOT include the directory, or it is identical to the
		// default and silently matches nothing — the flag would appear to work while
		const key = options.crossFolderMatching
			? `xf:${normalizeKey(c.groupTitle)}`
			: `${normalizeKey(c.groupTitle)}|${normalizeKey(dirOf(c.file.relPath))}`;
		groups.set(key, [...(groups.get(key) ?? []), c]);
	}

	const keep = new Set<string>();
	const toDelete: DeleteDecision[] = [];
	const repoint: RepointDecision[] = [];
	const skipped: Array<{ file: LibraryFile; reason: string }> = [];

	for (const members of groups.values()) {
		if (members.length === 1) {
			const only = members[0];
			keep.add(only.file.relPath);
			continue;
		}

		// A group with a trailing "(n)" and its unsuffixed partner is a duplicate
		// family. Anything else sharing a name is two distinct recordings and must
		// both be kept: `Menace` and `Menace (2)` can both be real titles.
		const suffixed = members.filter((m) => m.suffixed && m.hasUnsuffixedSibling);
		const unsuffixed = members.filter((m) => !m.suffixed);
		const leftovers = members.filter((m) => !suffixed.includes(m) && !unsuffixed.includes(m));

		if (suffixed.length === 0) {
			// No duplicate marker among them: keep everything, flag for a human.
			for (const m of members) {
				keep.add(m.file.relPath);
				if (m.suffixed) {
					skipped.push({
						file: m.file,
						reason: 'suffixed but has no unsuffixed sibling in this folder — may be a real title',
					});
				}
			}
			continue;
		}

		// Family = the unsuffixed originals + their suffixed copies.
		const family = [...unsuffixed, ...suffixed];
		const ranked = [...family].sort((a, b) => {
			// Negative means "a first". So when B is the better file we must return a
			// POSITIVE value. This was inverted, which meant the unprefixed file always
			// won no matter what the suffix copy was — a 24-bit fetch would be deleted
			// in favour of the 16-bit original.
			if (isStrictlyBetter(b.file, a.file)) return 1;
			if (isStrictlyBetter(a.file, b.file)) return -1;
			// Deterministic tie-break: unprefixed first, then lowest suffix.
			if (a.suffixed !== b.suffixed) return a.suffixed ? 1 : -1;
			return a.suffixIndex - b.suffixIndex;
		});
		const winner = ranked[0];

		for (const other of leftovers) {
			// A suffixed file with no unsuffixed partner: never delete it. It may be
			// the only copy of a real title.
			keep.add(other.file.relPath);
			skipped.push({
				file: other.file,
				reason: 'suffixed with no unsuffixed sibling — kept, may be a real title',
			});
		}

		for (const m of family) {
			if (m.file.relPath === winner.file.relPath) {
				keep.add(m.file.relPath);
				continue;
			}
			// INVARIANT: the survivor must be indexed, or be ADOPTED FIRST.
			//
			// Two-phase, and the order is the whole point: the runner inserts every
			// adopted row, verifies the insert landed, and only then deletes anything.
			// At no point does a recording exist only as an orphan on disk.
			//
			// An earlier version force-added adopted files back into `keep`, which let
			// one file be adopted AND deleted in the same plan.
			const survivorWillBeIndexed = winner.indexed || !winner.rowId;
			if (!survivorWillBeIndexed) {
				keep.add(m.file.relPath);
				skipped.push({
					file: m.file,
					reason:
						`kept: better copy ${winner.basename} is not indexed yet, so deleting before it is ` +
						'indexed would risk losing the only copy',
				});
				continue;
			}
			toDelete.push({
				file: m.file,
				survivor: winner.file,
				reason: winner.suffixed ? 'repoint_to_better' : 'duplicate_of_sibling',
				rowId: m.rowId,
			});
		}

		// A row pointing at a loser follows the winner — which is how a BETTER copy
		// that arrived second ends up being the one the library serves.
		for (const m of family) {
			if (m.file.relPath === winner.file.relPath) continue;
			if (m.rowId) {
				repoint.push({
					rowId: m.rowId,
					fromRelPath: m.file.relPath,
					toRelPath: winner.file.relPath,
				});
			}
		}
		// The winner was an orphan: it is adopted this run, so give it the family's
		// row rather than leaving a rowless file and a separate row for the same song.
		if (!winner.rowId && !winner.indexed) {
			const rowHolder = family.find((m) => m.rowId !== null);
			if (rowHolder?.rowId) {
				repoint.push({
					rowId: rowHolder.rowId,
					fromRelPath: rowHolder.file.relPath,
					toRelPath: winner.file.relPath,
				});
			}
		}
	}

	// A delete whose row is being repointed elsewhere is fine; but a delete of a
	// file that is ALSO the repoint target would be incoherent. Assert it.
	// Two loops can legitimately want the same row repointed (a loser holds the row,
	// and the unindexed winner also needs adopting). Collapse to one decision per row.
	const seenRepoint = new Set<string>();
	const uniqueRepoint = repoint.filter((rp) => {
		if (seenRepoint.has(rp.rowId)) return false;
		seenRepoint.add(rp.rowId);
		return true;
	});

	const deleteSet = new Set(toDelete.map((d) => d.file.relPath));
	for (const rp of uniqueRepoint) {
		if (deleteSet.has(rp.toRelPath)) {
			throw new Error(
				`incoherent plan: row ${rp.rowId} would be repointed to ${rp.toRelPath}, which is also scheduled for deletion`,
			);
		}
	}
	// Never schedule a deletion of a file the plan does not keep.
	for (const d of toDelete) {
		if (deleteSet.has(d.survivor.relPath)) {
			throw new Error(
				`incoherent plan: survivor ${d.survivor.relPath} is also being deleted`,
			);
		}
	}

	// A file scheduled for deletion must never also be adopted, and must not be
	// listed as kept. This previously ran unconditionally and re-added deleted files
	// to both sets, so the plan said "delete this" and "keep this" at once.
	const survivingAdopt = adopt.filter((a) => !deleteSet.has(a.relPath));
	for (const a of survivingAdopt) keep.add(a.relPath);

	return {
		adopt: survivingAdopt,
		keep: [...keep].map((relPath) => files.find((f) => f.relPath === relPath)!),
		delete: toDelete,
		repoint: uniqueRepoint,
		skipped,
	};
}

/** Human-readable summary for a dry run. */
export function describePlan(plan: ReconcilePlan): string {
	const lines: string[] = [];
	lines.push(`  adopt   ${plan.adopt.length} file(s) with no index row`);
	lines.push(`  delete  ${plan.delete.length} duplicate file(s)`);
	lines.push(`  repoint ${plan.repoint.length} row(s) to a surviving file`);
	lines.push(`  keep    ${plan.keep.length} file(s)`);
	lines.push(`  skipped ${plan.skipped.length} file(s), deliberately not acted on`);
	for (const d of plan.delete) {
		const better = d.survivor.bitDepth != null ? `${d.survivor.bitDepth}bit` : 'unknown depth';
		lines.push(
			`    DEL ${d.file.relPath}  ->  KEEP ${d.survivor.relPath}  (${better}, ${d.reason})`,
		);
	}
	for (const s of plan.skipped) lines.push(`    SKIP ${s.file.relPath}  (${s.reason})`);
	return lines.join('\n');
}
