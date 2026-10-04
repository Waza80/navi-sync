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

const MAX_COMPONENT_LEN = 120;

export interface PathMeta {
	title: string;
	artist: string;
	album: string | null;
	trackNumber?: number | null;
}

/** Sanitize a single path component. Never returns '', '/', or '.'-prefixed. */
export function sanitizeComponent(raw: string, fallback = 'Unknown'): string {
	let s = raw.normalize('NFC');
	s = s.replace(/[\\/:*?"<>|]/g, '');
	// eslint-disable-next-line no-control-regex -- intentional: strip control chars
	s = s.replace(/[\u0000-\u001f]/g, '');
	s = s.replace(/\s+/g, ' ').trim();
	s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
	if (s.length > MAX_COMPONENT_LEN) s = s.slice(0, MAX_COMPONENT_LEN).trimEnd();
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
