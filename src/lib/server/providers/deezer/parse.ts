/**
 * Pure Deezer URL parsing (unit-tested, no network).
 *
 * Recognised, all with or without a locale prefix (`/nl/artist/…`):
 *   track   https://www.deezer.com/{cc}/track/{id}
 *   album   https://www.deezer.com/{cc}/album/{id}
 *   artist  https://www.deezer.com/{cc}/artist/{id}
 * plus bare numeric ids (treated as track ids) and link.deezer.com short links,
 * which need a redirect to be classified.
 *
 * The kind matters: an artist or album link cannot be downloaded as a single
 * track, so a caller that only wanted audio has to fan out instead of failing
 * with an unhelpful "could not be parsed".
 */

// Locale segments (nl, fr, de, it, es, pt, br, at, be, dk, fi, no, pl, se, ch,
// za, ae, ar, il, in, mx, my, ph, sg, th, tr, hu, ro, ru, ua, id, jp, ko, cn)
// are optional and sit between the host and the resource, so the pattern matches
// "at most one path segment that is not a known resource kind".
const TRACK_RE = /(?:^|\/)(?:[a-z]{2}\/)?track\/(\d+)(?:[/?#]|$)/i;
const ALBUM_RE = /(?:^|\/)(?:[a-z]{2}\/)?album\/(\d+)(?:[/?#]|$)/i;
const ARTIST_RE = /(?:^|\/)(?:[a-z]{2}\/)?artist\/(\d+)(?:[/?#]|$)/i;

export type DeezerRefKind = 'track' | 'album' | 'artist';

export interface ParsedDeezerRef {
	id: string;
	kind: DeezerRefKind;
}

/** Classify any Deezer URL shape. Returns null for non-Deezer or unknown paths. */
export function parseDeezerUrl(input: string): ParsedDeezerRef | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	// A bare id is only meaningful as a track id — that is what the id columns and
	// the existing callers pass in.
	if (/^\d{4,15}$/.test(trimmed)) return { id: trimmed, kind: 'track' };
	try {
		const url = new URL(trimmed);
		if (!/(^|\.)deezer\.com$/.test(url.hostname)) return null;
		const track = TRACK_RE.exec(url.pathname);
		if (track) return { id: track[1], kind: 'track' };
		const album = ALBUM_RE.exec(url.pathname);
		if (album) return { id: album[1], kind: 'album' };
		const artist = ARTIST_RE.exec(url.pathname);
		if (artist) return { id: artist[1], kind: 'artist' };
		return null;
	} catch {
		return null;
	}
}

/** True for short links (link.deezer.com) that require redirect resolution. */
export function isDeezerShortLink(input: string): boolean {
	try {
		const url = new URL(input.trim());
		return url.hostname === 'link.deezer.com';
	} catch {
		return false;
	}
}
