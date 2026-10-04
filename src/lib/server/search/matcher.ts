/**
 * Song matching for playlist/CSV imports ("Spotify-like" exports).
 * Pure functions — unit-tested. Scoring guards against wrong matches:
 * title similarity dominates, artist overlap confirms, duration confirms
 * (±3s); below-threshold results are reported as unmatched instead of
 * downloading the wrong song.
 */

export interface MatchCandidate {
	title: string;
	artist: string;
	album?: string | null;
	durationSec?: number | null;
}

export interface MatchRow {
	title: string;
	artist: string;
	album?: string | null;
	durationSec?: number | null;
}

export function normalize(s: string): string {
	return s
		.toLowerCase()
		.replace(/\(.*?\)|\[.*?\]/gu, ' ')
		.replace(/\b(remaster(ed)?|deluxe|explicit|single|version|feat\.?|ft\.?)\b/giu, ' ')
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim();
}

function tokenOverlap(a: string, b: string): number {
	const sa = new Set(normalize(a).split(' ').filter(Boolean));
	const sb = normalize(b).split(' ').filter(Boolean);
	if (sa.size === 0 || sb.length === 0) return 0;
	let hit = 0;
	for (const t of sb) if (sa.has(t)) hit++;
	return hit / Math.max(1, sb.length);
}

export interface MatchVerdict {
	candidate: MatchCandidate | null;
	score: number;
	reason: string;
}

/**
 * Picks the best candidate for a desired song, or null with a reason.
 * Threshold: title ≥ 0.6 overlap AND artist ≥ 0.5 overlap AND (duration
 * matches when both are known, else no penalty).
 */
export function findBestMatch(desired: MatchRow, candidates: MatchCandidate[]): MatchVerdict {
	if (candidates.length === 0) return { candidate: null, score: 0, reason: 'no candidates' };

	let best: { c: MatchCandidate; score: number } | null = null;
	for (const c of candidates) {
		const titleSim = tokenOverlap(desired.title, c.title);
		const artistSim = tokenOverlap(desired.artist, c.artist);
		let score = titleSim * 0.6 + artistSim * 0.4;
		if (
			desired.durationSec != null &&
			c.durationSec != null &&
			Math.abs(desired.durationSec - c.durationSec) <= 3
		) {
			score += 0.15;
		}
		if (!best || score > best.score) best = { c, score };
	}
	if (!best) return { candidate: null, score: 0, reason: 'no candidates' };

	const titleSim = tokenOverlap(desired.title, best.c.title);
	const artistSim = tokenOverlap(desired.artist, best.c.artist);
	if (titleSim < 0.6) return { candidate: null, score: best.score, reason: 'title mismatch' };
	if (artistSim < 0.5) return { candidate: null, score: best.score, reason: 'artist mismatch' };
	if (
		desired.durationSec != null &&
		best.c.durationSec != null &&
		Math.abs(desired.durationSec - best.c.durationSec) > 8
	) {
		return { candidate: null, score: best.score, reason: 'duration mismatch' };
	}
	return { candidate: best.c, score: best.score, reason: 'matched' };
}

/**
 * CSV parser: handles quoted fields, embedded commas/newlines, and CRLF.
 * Returns rows as string arrays (header row included).
 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else inQuotes = false;
			} else field += ch;
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ',') {
			row.push(field);
			field = '';
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			field = '';
			if (row.length > 1 || row[0] !== '') rows.push(row);
			row = [];
		} else field += ch;
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		if (row.length > 1 || row[0] !== '') rows.push(row);
	}
	return rows;
}

export interface PlaylistEntry {
	title: string;
	artist: string;
	album: string | null;
	durationSec: number | null;
	/** Present in Deezer library exports ("Deezer - id") — skips search. */
	providerTrackId?: string | null;
	/** Present in Deezer library exports. */
	isrc?: string | null;
}

/**
 * Converts a Spotify-style CSV export to playlist entries.
 * Detects columns by header name; supports the common Spotify export layout
 * ("Track Name", "Artist Name(s)", "Album Name", "Duration (ms)") and generic
 * variants (name/title, artist(s), album, duration ms/s).
 */
export function csvToPlaylist(
	text: string,
	maxRows = 200,
): { entries: PlaylistEntry[]; skipped: number } {
	// Deezer exports begin with a UTF-8 BOM.
	const rows = parseCsv(text.replace(/^\ufeff/u, ''));
	if (rows.length === 0) return { entries: [], skipped: 0 };
	const header = rows[0].map((h) => h.trim().toLowerCase());
	const idx = (names: string[]): number =>
		header.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));

	const iTitle = idx(['track name', 'name', 'title', 'song']);
	const iArtist = idx(['artist name(s)', 'artist names', 'artist name', 'artist', 'artists']);
	const iAlbum = idx(['album name', 'album']);
	const iDuration = idx(['duration (ms)', 'duration ms', 'duration', 'length']);
	const iDzId = idx(['deezer - id', 'deezer id', 'deezer-id']);
	const iIsrc = idx(['isrc']);

	// Deezer library export: exact ids present — no search matching needed.
	if (iDzId !== -1 && iTitle !== -1) {
		const entries: PlaylistEntry[] = [];
		let skipped = 0;
		for (const row of rows.slice(1)) {
			const id = (row[iDzId] ?? '').trim();
			const title = (row[iTitle] ?? '').trim();
			if (!id || !/^\d+$/.test(id)) {
				skipped++;
				continue;
			}
			entries.push({
				title,
				artist: (row[iArtist] ?? '').trim(),
				album: iAlbum !== -1 ? (row[iAlbum] ?? '').trim() || null : null,
				durationSec: null,
				providerTrackId: id,
				isrc: iIsrc !== -1 ? (row[iIsrc] ?? '').trim() || null : null,
			});
			if (entries.length >= maxRows) break;
		}
		return { entries, skipped };
	}

	if (iTitle === -1 || iArtist === -1) {
		// No recognizable header — try "Artist - Title" one-per-line format.
		const entries: PlaylistEntry[] = [];
		for (const row of rows.slice(0, maxRows)) {
			const line = row[0] ?? '';
			const parts = line.split(' - ');
			if (parts.length >= 2) {
				entries.push({
					artist: parts[0].trim(),
					title: parts.slice(1).join(' - ').trim(),
					album: null,
					durationSec: null,
				});
			}
		}
		return {
			entries: entries.slice(0, maxRows),
			skipped: Math.max(0, rows.length - entries.length),
		};
	}

	const entries: PlaylistEntry[] = [];
	let skipped = 0;
	for (const row of rows.slice(1)) {
		const title = (row[iTitle] ?? '').trim();
		const artist = (row[iArtist] ?? '').trim();
		if (!title || !artist) {
			skipped++;
			continue;
		}
		let durationSec: number | null = null;
		if (iDuration !== -1) {
			const raw = Number.parseFloat(row[iDuration] ?? '');
			if (Number.isFinite(raw))
				durationSec = raw > 10000 ? Math.round(raw / 1000) : Math.round(raw);
		}
		entries.push({
			title,
			artist,
			album: iAlbum !== -1 ? (row[iAlbum] ?? '').trim() || null : null,
			durationSec,
			isrc: iIsrc !== -1 ? (row[iIsrc] ?? '').trim() || null : null,
		});
		if (entries.length >= maxRows) break;
	}
	return { entries, skipped };
}
