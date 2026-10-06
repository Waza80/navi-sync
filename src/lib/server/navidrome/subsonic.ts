import { createHash, randomBytes } from 'node:crypto';
import { logger } from '$lib/server/logger';

/**
 * Minimal Subsonic API client (Navidrome implements it) for Phase 1:
 *  - ping()  — connection test
 *  - startScan() — trigger a library scan
 * Auth: token = md5(password + salt), salt random per request.
 * Docs: http://www.subsonic.org/pages/api.jsp
 */

const log = logger;
const CLIENT_ID = 'navisync';
const API_VERSION = '1.16.1';
const TIMEOUT_MS = 15_000;

export interface SubsonicResult {
	ok: boolean;
	status?: string;
	serverVersion?: string | null;
	error?: string;
}

function authParams(username: string, password: string): string {
	const salt = randomBytes(8).toString('hex');
	const token = createHash('md5')
		.update(password + salt)
		.digest('hex');
	return `u=${encodeURIComponent(username)}&t=${token}&s=${salt}&v=${API_VERSION}&c=${CLIENT_ID}&f=json`;
}

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, '');
}

async function call(
	baseUrl: string,
	endpoint: string,
	username: string,
	password: string,
): Promise<SubsonicResult> {
	try {
		const url = `${normalizeBaseUrl(baseUrl)}/rest/${endpoint}?${authParams(username, password)}`;
		const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) {
			return { ok: false, error: `HTTP ${res.status}` };
		}
		const body = (await res.json()) as {
			'subsonic-response'?: {
				status?: string;
				version?: string;
				error?: { message?: string };
			};
		};
		const sr = body['subsonic-response'];
		if (!sr) return { ok: false, error: 'Malformed response (not a Subsonic server?)' };
		if (sr.status !== 'ok') {
			return { ok: false, status: sr.status, error: sr.error?.message ?? 'Subsonic error' };
		}
		return { ok: true, status: sr.status, serverVersion: sr.version ?? null };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.warn('subsonic call failed', { endpoint, error: msg });
		return { ok: false, error: msg };
	}
}

export function ping(baseUrl: string, username: string, password: string): Promise<SubsonicResult> {
	return call(baseUrl, 'ping', username, password);
}

/**
 * Trigger a library scan.
 *
 * `fullScan` matters: a normal scan is incremental and will happily leave rows for
 * files that have been deleted. After a dedupe that removed files directly from a
 * READ-ONLY mount, Navidrome's index still listed them — 361 rows of 1085 pointed at
 * files that no longer existed, and every one rendered greyed out. Navidrome's
 * extension accepts `fullScan=true`, which re-walks the tree and drops what is gone.
 */
export function startScan(
	baseUrl: string,
	username: string,
	password: string,
	fullScan = false,
): Promise<SubsonicResult> {
	return call(baseUrl, `startScan${fullScan ? '?fullScan=true' : ''}`, username, password);
}

export interface ScanStatusResult {
	ok: boolean;
	/** True while Navidrome is still scanning the library. */
	scanning: boolean;
	/** Tracks indexed so far (when reported). */
	count?: number | null;
	error?: string;
}

/**
 * Pollable scan state (Navidrome Subsonic extension: getScanStatus →
 * scanStatus { scanning, count }). Used by the indexation-repair flow to
 * wait until a triggered scan actually finishes.
 */
/* ── catalogue reads (diagnostics / repair) ─────────────────────────────── */

/** One album plus its track list, as Navidrome indexed it. */
export interface NavidromeAlbumDetail {
	id: string;
	name: string | null;
	artist: string | null;
	songCount: number;
	songs: Array<Record<string, unknown>>;
}

/**
 * Fetch one album by Navidrome id.
 *
 * Used by repair diagnostics: comparing the name Navidrome indexed against the
 * canonical DB metadata is how a tag-encoding problem (every non-ASCII byte
 * written as '#') becomes visible.
 */
export async function getAlbum(
	baseUrl: string,
	username: string,
	password: string,
	id: string,
): Promise<NavidromeAlbumDetail | null> {
	// getAlbum returns the full payload rather than the ping-shaped result the
	// shared helper yields, so query it directly.
	const res = await fetch(
		`${normalizeBaseUrl(baseUrl)}/rest/getAlbum?${authParams(username, password)}&id=${encodeURIComponent(id)}`,
		{ headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
	);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = (await res.json()) as {
		'subsonic-response'?: { status?: string; album?: Record<string, unknown>; error?: unknown };
	};
	const sr = body['subsonic-response'];
	if (!sr || sr.status !== 'ok') {
		throw new Error('Subsonic error: album unavailable');
	}
	try {
		const album = sr.album;
		if (!album) return null;
		const songs = Array.isArray(album['song'])
			? (album['song'] as Array<Record<string, unknown>>)
			: [];
		const albumId = album['id'];
		return {
			id: typeof albumId === 'string' || typeof albumId === 'number' ? String(albumId) : id,
			name: (album['name'] as string) ?? null,
			artist: (album['artist'] as string) ?? null,
			songCount: Number(album['songCount'] ?? songs.length),
			songs,
		};
	} catch (err) {
		log.debug('getAlbum failed', { id, error: String(err) });
		return null;
	}
}

export async function getScanStatus(
	baseUrl: string,
	username: string,
	password: string,
): Promise<ScanStatusResult> {
	try {
		const url = `${normalizeBaseUrl(baseUrl)}/rest/getScanStatus?${authParams(username, password)}`;
		const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) {
			return { ok: false, scanning: false, error: `HTTP ${res.status}` };
		}
		const body = (await res.json()) as {
			'subsonic-response'?: {
				status?: string;
				version?: string;
				error?: { message?: string };
				scanStatus?: { scanning?: boolean; count?: number };
			};
		};
		const sr = body['subsonic-response'];
		if (!sr)
			return {
				ok: false,
				scanning: false,
				error: 'Malformed response (not a Subsonic server?)',
			};
		if (sr.status !== 'ok') {
			return { ok: false, scanning: false, error: sr.error?.message ?? 'Subsonic error' };
		}
		const st = sr.scanStatus;
		if (!st || typeof st.scanning !== 'boolean') {
			return { ok: false, scanning: false, error: 'Server did not report scanStatus' };
		}
		return { ok: true, scanning: st.scanning, count: st.count ?? null };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.warn('subsonic scan-status failed', { error: msg });
		return { ok: false, scanning: false, error: msg };
	}
}
