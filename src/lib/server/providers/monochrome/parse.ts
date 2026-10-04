/**
 * Monochrome link/id parsing (pure, unit-tested).
 * Accepted inputs:
 *   - https://<instance-host>/track/<id>
 *   - monochrome://track/<id>
 *   - bare numeric ids (routed to the configured instance)
 * Album/playlist/artist links are recognized now; batch fan-out lands later.
 */

export type MonochromeKind = 'track' | 'album' | 'playlist' | 'artist';

export interface ParsedMonochromeRef {
	kind: MonochromeKind;
	id: string;
}

const KIND_PATHS: Array<[RegExp, MonochromeKind]> = [
	[/\/track\/([^/?#]+)/i, 'track'],
	[/\/album\/([^/?#]+)/i, 'album'],
	[/\/playlist\/([^/?#]+)/i, 'playlist'],
	[/\/artist\/([^/?#]+)/i, 'artist'],
];

export function parseMonochromeInput(input: string): ParsedMonochromeRef | null {
	const trimmed = input.trim();
	if (/^\d{1,15}$/.test(trimmed)) return { kind: 'track', id: trimmed };
	for (const [re, kind] of KIND_PATHS) {
		const m = re.exec(trimmed);
		if (m?.[1]) return { kind, id: m[1] };
	}
	try {
		const url = new URL(trimmed);
		// TIDAL-style links routed through an instance
		for (const [re, kind] of KIND_PATHS) {
			const m = re.exec(url.pathname);
			if (m?.[1]) return { kind, id: m[1] };
		}
	} catch {
		// not a URL
	}
	return null;
}
