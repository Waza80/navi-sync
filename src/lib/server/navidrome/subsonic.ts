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

export function startScan(
	baseUrl: string,
	username: string,
	password: string,
): Promise<SubsonicResult> {
	return call(baseUrl, 'startScan', username, password);
}
