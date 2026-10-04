/**
 * Pure Deezer URL parsing (unit-tested, no network).
 * Supported: https://www.deezer.com/{cc}/track/{id}, deezer.com/track/{id},
 * page hosts with query strings, and bare numeric ids.
 */

const TRACK_RE = /(?:^|\/)track\/(\d+)(?:[/?#]|$)/;

export interface ParsedDeezerRef {
	id: string;
}

export function parseDeezerTrackUrl(input: string): ParsedDeezerRef | null {
	const trimmed = input.trim();
	if (/^\d{4,15}$/.test(trimmed)) return { id: trimmed };
	try {
		const url = new URL(trimmed);
		if (!/(^|\.)deezer\.com$/.test(url.hostname)) return null;
		const match = TRACK_RE.exec(url.pathname);
		return match ? { id: match[1] } : null;
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
