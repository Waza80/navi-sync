/**
 * Navidrome-compatible library path layout (pure functions — unit-tested).
 *
 *   <library>/<Artist>/<Album>/<NN - Title>.<ext>
 *   <library>/<Artist>/<Album>/<NN - Title>.lrc|.txt
 *
 * Every path component is sanitized against traversal and filesystem-hostile
 * characters; components never escape the library root.
 */

const WINDOWS_RESERVED = new Set([
	'CON',
	'PRN',
	'AUX',
	'NUL',
	'COM1',
	'COM2',
	'COM3',
	'COM4',
	'COM5',
	'COM6',
	'COM7',
	'COM8',
	'COM9',
	'LPT1',
	'LPT2',
	'LPT3',
	'LPT4',
	'LPT5',
	'LPT6',
	'LPT7',
	'LPT8',
	'LPT9',
]);

/**
 * Maximum path component size.
 *
 * Measured in BYTES, because that is what the filesystem enforces: ext4 caps one
 * component at 255 bytes and a character can cost 2 (accented), 3 (CJK) or 4
 * (astral) bytes. The old 120-CHAR budget let a CJK title reach 360 bytes and
 * fail with ENAMETOOLONG.
 *
 * 220 leaves room for the "NN - " prefix and the extension on the SAME
 * component's limit. It is deliberately generous so that zalgo-styled titles —
 * which are one grapheme per letter but hundreds of bytes — survive intact
 * rather than being cut mid-word.
 */
const MAX_COMPONENT_BYTES = 220;

/** Split into grapheme clusters so truncation never splits a letter or a mark. */
function graphemes(s: string): string[] {
	// Intl.Segmenter keeps combining marks attached to their base character,
	// which is exactly what we need: cutting between a base and its marks would
	// leave a stray diacritic behind.
	const Segmenter = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
	if (Segmenter) {
		return [...new Segmenter('en', { granularity: 'grapheme' }).segment(s)].map(
			(x) => x.segment,
		);
	}
	return [...s];
}

function byteLength(s: string): number {
	return Buffer.byteLength(s, 'utf8');
}

/** Trim to a byte budget on a grapheme boundary. */
export function truncateToBytes(s: string, maxBytes: number): string {
	if (byteLength(s) <= maxBytes) return s;
	const parts = graphemes(s);
	let out = '';
	let used = 0;
	for (const g of parts) {
		const size = byteLength(g);
		if (used + size > maxBytes) break;
		out += g;
		used += size;
	}
	return out.trimEnd();
}

export interface PathMeta {
	title: string;
	artist: string;
	album: string | null;
	trackNumber?: number | null;
}

/** Sanitize a single path component. Never returns '', '/', or '.'-prefixed. */
export function sanitizeComponent(raw: string, fallback = 'Unknown'): string {
	// NFC first so visually identical names produce ONE folder. Without it,
	// "Björk" as U+00F6 and as "o"+U+0308 are different strings and split the
	// album across two directories.
	let s = raw.normalize('NFC');
	s = s.replace(/[\\/:*?"<>|]/g, '');
	// eslint-disable-next-line no-control-regex -- intentional: strip control chars
	s = s.replace(/[\u0000-\u001f]/g, '');
	// Zero-width and bidi marks are invisible in a file listing but break
	// matching between the DB, the path and Navidrome's index.
	s = s.replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '');
	s = s.replace(/\s+/g, ' ').trim();
	s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
	s = truncateToBytes(s, MAX_COMPONENT_BYTES);
	const upper = s.toUpperCase();
	if (WINDOWS_RESERVED.has(upper)) s = `_${s}`;
	if (s.length === 0) s = fallback;
	return s;
}

function padTrackNumber(n: number | null | undefined): string {
	if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return '00';
	return String(Math.min(999, Math.round(n))).padStart(2, '0');
}

/** "Artist/Album/NN - Title" (no extension). */
export function trackBaseRelativePath(meta: PathMeta): string {
	const artist = sanitizeComponent(meta.artist, 'Unknown Artist');
	const album = sanitizeComponent(meta.album ?? 'Unknown Album', 'Unknown Album');
	const title = sanitizeComponent(meta.title, 'Unknown Title');
	return `${artist}/${album}/${padTrackNumber(meta.trackNumber)} - ${title}`;
}

/** Full audio path relative to the library root. */
export function trackRelativePath(meta: PathMeta, ext: string): string {
	const safeExt = sanitizeComponent(ext.replace(/^\./, ''), 'bin').toLowerCase();
	return `${trackBaseRelativePath(meta)}.${safeExt}`;
}

/** Sidecar lyrics path derived from the audio path (same basename). */
export function lyricsFilePath(audioRelativePath: string, ext: 'lrc' | 'txt'): string {
	const dir = audioRelativePath.includes('/')
		? audioRelativePath.slice(0, audioRelativePath.lastIndexOf('/'))
		: '';
	const base = audioRelativePath.slice(
		dir.length > 0 ? dir.length + 1 : 0,
		audioRelativePath.lastIndexOf('.'),
	);
	return dir.length > 0 ? `${dir}/${base}.${ext}` : `${base}.${ext}`;
}

/** Album cover path: <library>/<Artist>/<Album>/cover.jpg */
export function coverRelativePath(meta: PathMeta): string {
	const artist = sanitizeComponent(meta.artist, 'Unknown Artist');
	const album = sanitizeComponent(meta.album ?? 'Unknown Album', 'Unknown Album');
	return `${artist}/${album}/cover.jpg`;
}
