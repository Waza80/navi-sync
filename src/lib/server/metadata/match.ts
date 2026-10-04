import { findBestMatch } from '$lib/server/search/matcher';

/**
 * Strict candidate selection for metadata enrichment.
 *
 * Enrichment is dangerous: a loose match writes the WRONG album (and folder)
 * onto a real file, which is far worse than leaving the field empty. So a
 * candidate is only accepted when it survives the same guard used for playlist
 * imports (title + artist token overlap, duration when known) AND the release
 * looks like the original studio record rather than a compilation, live boot,
 * remix or unofficial rip.
 */

/** Release titles that indicate a non-canonical version. */
const NON_CANONICAL =
	/\b(live|unplugged|bootleg|bootleg|remix|remixed|cover|tribute|compilation|greatest hits|best of|anthology|mix(?:es)?|extended|edit|version|anniversary|edition|radio|session|instrumental|demo|mono|stereo|vinyl|remaster)/i;

/** True when the release title looks like the canonical studio album. */
export function looksCanonical(title: string | null | undefined): boolean {
	if (!title) return false;
	return !NON_CANONICAL.test(title);
}

export interface EnrichCandidate {
	title: string;
	artist: string;
	album?: string | null;
	durationSec?: number | null;
}

/**
 * Returns the candidate that strictly matches the wanted song, or null.
 * Never guesses — an unmatched result leaves the field alone.
 */
export function pickStrict(
	wanted: EnrichCandidate,
	candidates: EnrichCandidate[],
): EnrichCandidate | null {
	if (candidates.length === 0) return null;
	const verdict = findBestMatch(
		{
			title: wanted.title,
			artist: wanted.artist,
			album: wanted.album,
			durationSec: wanted.durationSec,
		},
		candidates,
	);
	if (!verdict.candidate) return null;
	return (
		candidates.find(
			(c) => c.title === verdict.candidate?.title && c.artist === verdict.candidate?.artist,
		) ?? null
	);
}
