/**
 * Album-name variant detection, and the rename plan that fixes it.
 *
 * MEASURED on the live library (675 files):
 *   - 16 tracks sit in folders whose ALBUM tags differ only in case or a colon:
 *     'Koi no Yokan' / 'Koi No Yokan', 'NODA: le monde et les humains' /
 *     'NODA le monde et les humains', 'HYPERSIGIL 【chapitre 3】' /
 *     'HYPERSIGIL - chapitre 🜎'. Navidrome keys albums on the raw string, so each
 *     pair is two albums on the player.
 *   - 156 filenames end in ' (n)'. Only 6 have a same-length twin elsewhere, so
 *     most are part of the real title ('Moog City 2 (2)', 'The Tourist (2)',
 *     'souvenir (2)') and must NOT be stripped.
 *
 * So the rule here is evidence-based, never pattern-based: a ' (n)' is removed
 * only when a file with the same title-and-duration exists on the SAME album.
 * That is the signature of a download collision. A genuinely parenthesised
 * number has no twin, and stripping it invents a different song.
 */

/** A ' (n)' copy index — not a parenthesised part of a title. */
const INDEX_RE = /\s\((\d{1,3})\)$/;
export const INDEX_SUFFIX = INDEX_RE;

/**
 * Two recordings of one song differ by well under a second after encoding; a
 * different song on the same album never lands this close by accident.
 */
export const TOLERANCE_SEC = 1.5;

/** True when the string is already in NFC. */
export function isNFC(s: string): boolean {
	return s.normalize('NFC') === s;
}

/**
 * Case- and punctuation-insensitive key for "the same album".
 *
 * Case is safe to fold: album titles are not case-sensitive and the providers
 * disagree constantly ('Koi no Yokan' vs 'Koi No Yokan'). Punctuation is only
 * reduced, never discarded, so 'Y&W L'album' and 'Black Album' stay distinct.
 *
 * A colon IS dropped: it is a catalogue number rather than part of a title, and
 * that single character is what splits this library's NODA release in two.
 */
export function foldAlbum(album: string): string {
	let s = album.normalize('NFC');
	s = s.replace(/:/g, ' ');
	s = s.replace(/\s+/g, ' ');
	return s.trim().toLocaleLowerCase();
}

/** Case- and whitespace-insensitive title key. */
export function foldTitle(title: string): string {
	return title.normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/** Split a trailing copy index: 'Eleanor Rigby (3)' -> ['Eleanor Rigby', 3]. */
export function splitIndexSuffix(title: string): [string, number | null] {
	const m = INDEX_SUFFIX.exec(title);
	if (!m) return [title, null];
	return [title.slice(0, m.index), Number(m[1])];
}

export interface SiblingTrack {
	title: string;
	durationSec: number | null;
	discNumber?: number | null;
}

/**
 * True when `title`+duration is a duplicate index of another track on the same
 * album, so its ' (n)' should be removed.
 *
 * Requires a twin on the SAME album. That requirement is what protects the 150
 * real titles in this library: nothing on the album is called 'Moog City 2', so
 * the ' (2)' belongs to the title.
 */
export function isDuplicateOfSibling(
	title: string,
	durationSec: number | null,
	sameAlbum: readonly SiblingTrack[],
): boolean {
	if (durationSec == null) return false;
	const ownBase = foldTitle(splitIndexSuffix(title)[0]);
	const ownIndex = splitIndexSuffix(title)[1];

	for (const other of sameAlbum) {
		if (!other || other.title === title || other.durationSec == null) continue;
		if (Math.abs(other.durationSec - durationSec) > TOLERANCE_SEC) continue;
		const otherBase = foldTitle(splitIndexSuffix(other.title)[0]);
		if (otherBase !== ownBase) continue;
		// A twin on the same album with the same length is a collision. The ' (n)'
		// only has to be on ONE of the pair: the first fetch may have written 'X'
		// and a retry 'X (2)', in which case the plain file is the one to fix.
		if (ownIndex !== null || splitIndexSuffix(other.title)[1] !== null) return true;
	}
	return false;
}

export interface AlbumRow {
	id: string;
	title: string;
	album: string;
	durationSec: number | null;
	discNumber: number | null;
}

export interface AlbumRename {
	id: string;
	from: string;
	to: string;
	/** Carried through unchanged: a rename must never flatten a 2-disc release. */
	discNumber: number | null;
}

export interface AlbumPlan {
	albumKey: string;
	canonical: string;
	variants: Record<string, number>;
	updates: AlbumRename[];
}

/**
 * One spelling per album, for every album whose rows do not already agree.
 *
 * The canonical spelling is the most common one on the album; ties break on the
 * shorter then lexicographically-first spelling, so the result does not depend on
 * row order — the same property `mergeCreditLists` was rewritten for.
 */
export function planAlbumRename(rows: readonly AlbumRow[]): AlbumPlan[] {
	const groups = new Map<string, AlbumRow[]>();
	for (const row of rows) {
		const key = foldAlbum(row.album);
		const list = groups.get(key);
		if (list) list.push(row);
		else groups.set(key, [row]);
	}

	const out: AlbumPlan[] = [];
	for (const [albumKey, group] of groups) {
		const counts = new Map<string, number>();
		for (const r of group) counts.set(r.album, (counts.get(r.album) ?? 0) + 1);

		const canonical = [...counts.keys()].sort((a, b) => {
			const d = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
			if (d !== 0) return d;
			if (a.length !== b.length) return a.length - b.length;
			return a < b ? -1 : a > b ? 1 : 0;
		})[0];

		const updates: AlbumRename[] = [];
		for (const r of group) {
			if (r.album === canonical) continue;
			updates.push({ id: r.id, from: r.album, to: canonical, discNumber: r.discNumber });
		}
		// Sorted by id so the plan is byte-identical regardless of row order — the
		// canonical choice was already order-independent, and the list must be too.
		updates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		if (updates.length > 0) {
			out.push({
				albumKey,
				canonical,
				variants: Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : 1))),
				updates,
			});
		}
	}
	return out;
}

// ── the (n) artefact ─────────────────────────────────────────────────────────

/**
 * Remove a trailing ` (n)` — the artefact of an old download bug — unconditionally.
 *
 * Strict on purpose. `\s\((\d{1,3})\)$` matches a bare 1–3 digit group at the very
 * end and nothing else, so it never touches:
 *
 *   FLIP (Deluxe)              no digits
 *   Exit Music (For A Film)    no digits
 *   Love Song (feat. x)        no digits
 *   Paranoid Android (2011)    4 digits — a year, and 4 is not in {1,2,3}
 *   Chapter 12 (Part 2 of 3)   not at the end
 *
 * Every one of those is a genuine part of a title. The artefacts observed in the
 * library were (2), (3), (5), (9), (11), (22) — all 1–3 digits, all at the end,
 * all removable.
 */
export function stripIndexSuffix(title: string): string {
	const m = INDEX_SUFFIX.exec(title);
	return m ? title.slice(0, m.index) : title;
}

/** True when `stripIndexSuffix` would change this title. */
export function hasIndexSuffix(title: string): boolean {
	return INDEX_SUFFIX.test(title);
}

export interface SuffixStrip {
	id: string;
	from: string;
	to: string;
	filePath: string;
	newFilePath: string;
}

export interface SuffixPlan {
	strips: SuffixStrip[];
	/** Titles that would still collide inside their own folder after stripping. */
	collisions: Array<{ folder: string; title: string; files: string[] }>;
}

/**
 * Plan the ` (n)` removal for every row that has one, refusing to produce a plan
 * that would put two files on the same name.
 *
 * The collision check is the whole point of doing this as a plan rather than a
 * loop of renames: stripping ` (2)` off `06 - Creep (2)` must not land on a
 * `06 - Creep` that already exists, and discovering that after the first rename
 * leaves half the folder renamed.
 */
export function planSuffixStrip(
	rows: ReadonlyArray<{ id: string; title: string; filePath: string }>,
): SuffixPlan {
	const strips: SuffixStrip[] = [];
	// Every final filename that will exist after the pass, per folder.
	const occupancy = new Map<string, Map<string, string>>();

	const folderOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), 0));
	const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
	const extOf = (n: string) => n.slice(n.lastIndexOf('.'));

	const intended = new Map<string, string>();
	for (const r of rows) {
		const dir = folderOf(r.filePath);
		const name = nameOf(r.filePath);
		const ext = extOf(name);
		const stem = name.slice(0, -ext.length);
		// Decide from the FILENAME stem, which is where the artefact is written,
		// and strip the title only when the title carries one too. They can
		// diverge: 156 filenames were affected but only 139 titles, so 17 files
		// had a clean title and a suffixed name.
		if (!hasIndexSuffix(stem) && !hasIndexSuffix(r.title)) continue;
		// Rebuilding the name from the title would drop the '03 - ' track prefix,
		// because titles carry no track number.
		const newStem = stripIndexSuffix(stem);
		intended.set(r.filePath, `${dir}/${newStem}${ext}`);
		strips.push({
			id: r.id,
			from: r.title,
			to: hasIndexSuffix(r.title) ? stripIndexSuffix(r.title) : r.title,
			filePath: r.filePath,
			newFilePath: `${dir}/${newStem}${ext}`,
		});
	}

	// Occupy: files that are not moving keep their current name; files that are
	// moving take their destination.
	const finalName = new Map<string, string>();
	for (const r of rows) finalName.set(r.filePath, intended.get(r.filePath) ?? r.filePath);

	const byFolder = new Map<string, Map<string, string[]>>();
	for (const r of rows) {
		const final = finalName.get(r.filePath)!;
		const dir = folderOf(final);
		if (!byFolder.has(dir)) byFolder.set(dir, new Map());
		const m = byFolder.get(dir)!;
		if (!m.has(final)) m.set(final, []);
		m.get(final)!.push(r.filePath);
	}

	const collisions: SuffixPlan['collisions'] = [];
	for (const [dir, m] of byFolder) {
		for (const [final, paths] of m) {
			if (paths.length > 1)
				collisions.push({ folder: dir, title: final, files: paths.sort() });
		}
	}
	void occupancy;
	return { strips, collisions };
}
