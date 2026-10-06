/**
 * Canonicalising multi-artist strings, and agreeing one album artist per album.
 *
 * The failure this exists to prevent: two albums that are one album.
 *
 * Navidrome's album identity is (album, album artist), compared on raw tag
 * bytes. A collaborative release is credited per track, so a provider can hand
 * back a different credit string for different tracks of one release — and
 * navi-sync writes it into both the tag and the artist DIRECTORY. PRETTY
 * DOLLCORPSE had two directories whose names differed by a single name
 * (`reivilose`): one with 3 tracks, one with 10. Both directory names were also
 * corrupt, repeating `Ptite Soeur` twice, `neophron` twice and `prxpvne` three
 * times, because the credit list was concatenated rather than deduplicated. The
 * tag took its value from the directory, so Navidrome saw two album artists and
 * split one 13-track release into a 10-song and a 3-song album.
 *
 * Two rules follow, and both are pure so they can be tested without a library:
 *
 *  1. A comma-joined credit list is deduplicated, first-seen order preserved.
 *     `A, B, C, A, C, B` is `A, B, C`.
 *  2. Every track of an album gets the SAME album artist: the union of the names
 *     credited anywhere on it. Ten tracks saying `X, Y, Z` and three saying
 *     `X, Y, Z, W` is one release credited `X, Y, Z, W` — and `W` is not dropped
 *     just because a majority of tracks omitted it. Note the two variants are
 *     NOT equal on their own; it is the union over all thirteen rows that
 *     collapses them to one value.
 */

/** Normalise the separator/whitespace noise before splitting a credit list. */
function names(value: string): string[] {
	return value
		.split(/[,;/]/)
		.map((n) => n.replace(/\s+/g, ' ').trim())
		.filter((n) => n.length > 0);
}

/**
 * Deduplicate a comma-joined artist string, preserving first-seen order.
 *
 * Comparison is case- and NFC-insensitive so `Ptite Soeur` and `ptite soeur`
 * are one name, but the first spelling seen is the one kept — rewriting the
 * display casing of a name the provider chose is not this function's business.
 * The input is returned unchanged when it has no duplicates or separators, so
 * an ordinary single-artist string is never reformatted.
 */
export function canonicalArtistList(value: string): string {
	const parts = names(value.normalize('NFC'));
	if (parts.length === 0) return value;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of parts) {
		const key = p.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(p);
	}
	return out.length === parts.length ? parts.join(', ') : out.join(', ');
}

/**
 * One album artist for a whole album: the union of every credited name.
 *
 * Order is first-seen, so the answer depends on the order rows arrive in. That
 * is deliberate: reordering an artist's credits would rewrite the credit order
 * the provider chose, and the caller's row order is stable (a single SELECT).
 * Callers that need a stable order regardless of input should sort the result.
 *
 * `rows` is any iterable of the per-track album-artist values (null/empty
 * ignored). Returns null when no row carries one, so callers can distinguish
 * "nothing known" from "known to be empty".
 */
export function unifiedAlbumArtist(rows: Iterable<string | null | undefined>): string | null {
	const seen = new Set<string>();
	const out: string[] = [];
	let any = false;
	for (const row of rows) {
		if (row == null) continue;
		const trimmed = row.trim();
		if (!trimmed) continue;
		any = true;
		for (const p of names(trimmed.normalize('NFC'))) {
			const key = p.toLocaleLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(p);
		}
	}
	return any ? out.join(', ') : null;
}
