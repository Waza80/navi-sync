/**
 * Title/artist matching for lyric sources.
 *
 * Fuzzy matching is where wrong lyrics come from: a search for "Creep" can
 * return a live version, a cover, or a karaoke track, and a naive substring
 * score picks it happily. These helpers are deliberately conservative — a
 * source that cannot prove the recording is the right one returns null, and
 * the caller keeps looking (or settles for plain text).
 */

/** Lowercase, strip accents, drop feature/remaster noise, keep meaningful qualifiers. */
export function normalizeForMatch(input: string): string {
	return input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/['\u2019`]/g, '')
		.replace(/&/g, ' and ')
		.replace(/\((?:feat|ft|featuring|with|prod)\.?[^)]*\)/g, ' ')
		.replace(/\[(?:feat|ft|featuring|with|prod)\.?[^\]]*\]/g, ' ')
		.replace(/\((?:remaster(?:ed)?|deluxe|explicit|bonus|edition)[^)]*\)/g, ' ')
		.replace(/\[(?:remaster(?:ed)?|deluxe|explicit|bonus|edition)[^\]]*\]/g, ' ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/** True when two titles denote the same song (allowing one to carry extra words). */
export function titlesMatch(a: string, b: string): boolean {
	const na = normalizeForMatch(a);
	const nb = normalizeForMatch(b);
	if (!na || !nb) return false;
	if (na === nb) return true;
	const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
	return long.includes(short) && short.length / long.length >= 0.6;
}

/** True when two artist credits overlap enough to be the same act. */
export function artistsMatch(a: string, b: string): boolean {
	const na = normalizeForMatch(a);
	const nb = normalizeForMatch(b);
	if (!na || !nb) return false;
	if (na === nb || na.includes(nb) || nb.includes(na)) return true;
	const ta = new Set(na.split(' ').filter((w) => w.length > 2));
	const tb = new Set(nb.split(' ').filter((w) => w.length > 2));
	if (ta.size === 0 || tb.size === 0) return false;
	const overlap = [...ta].filter((w) => tb.has(w)).length;
	return overlap / Math.min(ta.size, tb.size) >= 0.5;
}

/** Duration gate. Unknown durations on either side pass; known ones must be close. */
export function durationClose(
	a: number | null | undefined,
	b: number | null | undefined,
	toleranceSec: number,
): boolean {
	if (!a || !b) return true;
	return Math.abs(a - b) <= toleranceSec;
}
