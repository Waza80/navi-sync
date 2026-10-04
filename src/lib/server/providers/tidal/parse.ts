/**
 * Tidal link/id parsing (pure, unit-tested).
 *
 * HOST-AWARE BY DESIGN. Path matching alone is not safe: every provider here
 * uses `/track/<id>`, so matching that shape anywhere would make a Deezer link
 * parse as Tidal. Because Tidal is checked FIRST in the registry (it reaches
 * 24/192), such a mis-parse would silently shadow Deezer rather than fail
 * loudly. So a real URL only matches when its host is a Tidal host.
 *
 * Accepted inputs:
 *   - https://tidal.com/track/<id>, https://listen.tidal.com/browse/album/<id>
 *   - https://<instance-host>/track/<id>  and  /track/?id=<id>
 *   - tidal://track/<id>
 *   - bare numeric ids (routed to the configured instance)
 *   - a playlist UUID
 */

export type TidalKind = 'track' | 'album' | 'playlist' | 'artist';

export interface ParsedTidalRef {
	kind: TidalKind;
	id: string;
}

const KIND_PATHS: Array<[RegExp, TidalKind]> = [
	[/\/track\/([^/?#]+)/i, 'track'],
	[/\/album\/([^/?#]+)/i, 'album'],
	[/\/playlist\/([^/?#]+)/i, 'playlist'],
	[/\/artist\/([^/?#]+)/i, 'artist'],
];

/** Hosts that legitimately serve Tidal-shaped /track/<id> links. */
const TIDAL_HOST = /^(?:[a-z0-9-]+\.)*(?:tidal\.com)$/i;

/** hiFi instances address tracks by query param: /track/?id=<id>. */
const INSTANCE_QUERY = /[?&](?:id|trackId)=(\d{1,15})\b/;

/** Tidal playlist ids are UUIDs, not numbers. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function matchPath(pathname: string): ParsedTidalRef | null {
	for (const [re, kind] of KIND_PATHS) {
		const m = re.exec(pathname);
		if (m?.[1]) return { kind, id: m[1] };
	}
	return null;
}

export function parseTidalInput(input: string): ParsedTidalRef | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	if (/^\d{1,15}$/.test(trimmed)) return { kind: 'track', id: trimmed };
	if (UUID.test(trimmed)) return { kind: 'playlist', id: trimmed };

	// A hiFi instance URL carries the id in the query string, not the path.
	// Safe on any host: the pattern is specific to the instance API.
	const q = INSTANCE_QUERY.exec(trimmed);
	if (q?.[1]) return { kind: 'track', id: q[1] };

	// `tidal://track/<id>` has no host, so its scheme is the authority.
	if (/^tidal:/i.test(trimmed)) return matchPath(trimmed.replace(/^tidal:/i, ''));

	try {
		const url = new URL(trimmed);
		// ONLY a Tidal host matches here. A self-hosted instance is a different
		// host (e.g. hifi.example.com) and is resolved by the provider against
		// the configured instance URL instead — see instanceTrackId().
		if (TIDAL_HOST.test(url.hostname)) return matchPath(url.pathname);
		return null;
	} catch {
		// Not a URL: accept a bare path so internal refs keep working.
		return matchPath(trimmed);
	}
}

/**
 * Track id from an URL served by a configured hiFi instance, or null.
 *
 * Kept separate from parseTidalInput because it needs the instance URL: the
 * same `/track/<id>` shape on an unknown host must NOT be claimed, or Deezer's
 * links would resolve here (Tidal is checked first).
 */
export function instanceTrackId(
	input: string,
	instanceUrl: string | null | undefined,
): string | null {
	if (!instanceUrl) return null;
	let target: URL;
	let candidate: URL;
	try {
		target = new URL(instanceUrl);
		candidate = new URL(input.trim());
	} catch {
		return null;
	}
	if (candidate.origin !== target.origin) return null;
	return INSTANCE_QUERY.exec(candidate.href)?.[1] ?? matchPath(candidate.pathname)?.id ?? null;
}
