import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { providerCredentials } from '$lib/server/db/schema';
import { decryptSecret, encryptSecret } from '$lib/server/crypto';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';
import { ProviderError } from '$lib/server/providers/types';

/**
 * Deezer gateway client — faithful TS port of the method used by
 * LuftVerbot/echo-deezer-extension (DeezerApi.kt):
 *
 *   1. GET gw-light user.getArl (api_token=null)      → `sid` cookie
 *   2. GET connect.deezer.com/oauth/user_auth.php     → access_token
 *      (app_id=447462, hash = md5(app_id + login + md5(pass) + client_secret))
 *   3. GET gw-light user.getArl (api_token=access)    → arl
 *   4. POST gw-light deezer.getUserData (cookie arl)  → checkForm CSRF token,
 *      USER_ID, license_token
 *   5. All later calls: POST gw-light?api_token=<checkForm> + arl cookie.
 *      On "Invalid CSRF token" → refresh session (re-login with env creds if
 *      needed), exactly like the extension's auto-recovery.
 *
 * The whole session (arl, sid, checkForm, license_token) is encrypted at rest
 * in provider_credentials and cached in memory per process.
 */

const log = logger;

const GW_URL = 'https://www.deezer.com/ajax/gw-light.php';
const AUTH_URL = 'https://connect.deezer.com/oauth/user_auth.php';
const APP_ID = '447462';
const CLIENT_ID = '447462';
const CLIENT_SECRET = 'a83bf7f38ad2f137e444727cfc3775cf';
// Legacy UA is significant: modern UAs receive JS challenges on gw-light.
const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36';
const REQUEST_TIMEOUT_MS = 20_000;

export interface DeezerSessionData {
	arl: string;
	sid: string;
	apiToken: string;
	userId: string;
	licenseToken: string;
}

const globalForDeezer = globalThis as unknown as {
	naviDeezerSession?: DeezerSessionData | null;
	naviDeezerRefresh?: Promise<void> | null;
};

function md5(input: string): string {
	return createHash('md5').update(input).digest('hex');
}

async function loadPersisted(): Promise<DeezerSessionData | null> {
	try {
		const rows = await db
			.select()
			.from(providerCredentials)
			.where(eq(providerCredentials.id, 'deezer'))
			.limit(1);
		const row = rows[0];
		if (!row) return null;
		const parsed = JSON.parse(decryptSecret(row.dataEnc)) as Partial<DeezerSessionData>;
		if (!parsed.arl) return null;
		return {
			arl: parsed.arl ?? '',
			sid: parsed.sid ?? '',
			apiToken: parsed.apiToken ?? '',
			userId: parsed.userId ?? '',
			licenseToken: parsed.licenseToken ?? '',
		};
	} catch (err) {
		log.warn('failed to load persisted deezer session', { error: String(err) });
		return null;
	}
}

async function persist(session: DeezerSessionData): Promise<void> {
	const dataEnc = encryptSecret(JSON.stringify(session));
	await db
		.insert(providerCredentials)
		.values({ id: 'deezer', dataEnc })
		.onConflictDoUpdate({
			target: providerCredentials.id,
			set: { dataEnc, updatedAt: new Date() },
		});
}

function newSidFromHeaders(headers: Headers): string | null {
	// fetch merges duplicate Set-Cookie values; find sid= in any of them.
	for (const raw of headers.getSetCookie()) {
		if (raw.startsWith('sid=')) return raw.slice(4).split(';')[0] ?? null;
	}
	return null;
}

async function gwGet(method: string, apiToken: string, cookie: string): Promise<Response> {
	const url = `${GW_URL}?method=${encodeURIComponent(method)}&input=3&api_version=1.0&api_token=${encodeURIComponent(apiToken)}`;
	return fetch(url, {
		method: 'GET',
		headers: {
			'User-Agent': UA,
			Accept: '*/*',
			Cookie: cookie,
		},
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

/** Step 1: anonymous gw-light call that issues a fresh `sid` cookie. */
async function fetchSid(): Promise<string> {
	const res = await gwGet('user.getArl', 'null', '');
	if (!res.ok)
		throw new ProviderError(
			`Deezer sid fetch failed: HTTP ${res.status}`,
			'PROVIDER_UNAVAILABLE',
		);
	const sid = newSidFromHeaders(res.headers);
	if (!sid) throw new ProviderError('Deezer did not issue a sid cookie', 'PROVIDER_UNAVAILABLE');
	// Drain body to free the socket.
	await res.arrayBuffer();
	return sid;
}

/** Step 2: password grant → access_token. */
async function fetchAccessToken(email: string, password: string, sid: string): Promise<string> {
	const md5Pass = md5(password);
	const hash = md5(CLIENT_ID + email + md5Pass + CLIENT_SECRET);
	const url =
		`${AUTH_URL}?app_id=${APP_ID}&login=${encodeURIComponent(email)}` +
		`&password=${encodeURIComponent(md5Pass)}&hash=${hash}&sid=${encodeURIComponent(sid)}`;
	// The credential exchange is TLS-fingerprint sensitive: Bun's TLS stack is
	// rejected (error 160) while Node/curl pass. Try native fetch first, then
	// fall back to a curl subprocess using the system TLS stack.
	for (const transport of ['fetch', 'curl'] as const) {
		try {
			const body =
				transport === 'fetch'
					? await httpGetJson(url, `sid=${sid}`)
					: await curlGetJson(url, `sid=${sid}`);
			if (!body.access_token) {
				const detail = body.error ?? JSON.stringify(body.errors ?? body);
				throw new ProviderError(`Deezer rejected credentials: ${detail}`, 'AUTH_FAILED');
			}
			return body.access_token;
		} catch (err) {
			if (transport === 'curl') {
				throw err instanceof ProviderError
					? err
					: new ProviderError(`Deezer auth failed: ${String(err)}`, 'AUTH_FAILED');
			}
			log.warn('deezer auth via fetch failed, retrying with curl transport', {
				error: String(err),
			});
		}
	}
	throw new ProviderError('Deezer auth failed', 'AUTH_FAILED');
}

async function httpGetJson(
	url: string,
	cookie: string,
): Promise<{ access_token?: string; errors?: unknown; error?: string }> {
	const res = await fetch(url, {
		method: 'GET',
		headers: { Cookie: cookie, 'User-Agent': UA },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new ProviderError(`Deezer auth failed: HTTP ${res.status}`, 'AUTH_FAILED');
	return (await res.json()) as { access_token?: string; errors?: unknown; error?: string };
}

/** curl transport — system TLS stack, immune to JS-runtime fingerprinting. */
async function curlGetJson(
	url: string,
	cookie: string,
): Promise<{ access_token?: string; errors?: unknown; error?: string }> {
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const run = promisify(execFile);
	const out = await run(
		'curl',
		[
			'-sS',
			'--max-time',
			String(REQUEST_TIMEOUT_MS / 1000),
			'-A',
			UA,
			'-H',
			`Cookie: ${cookie}`,
			url,
		],
		{ encoding: 'utf8', timeout: REQUEST_TIMEOUT_MS },
	);
	return JSON.parse(out.stdout) as { access_token?: string; errors?: unknown; error?: string };
}

/** Step 3: exchange access_token for the long-lived ARL cookie. */
async function fetchArl(accessToken: string, sid: string): Promise<string> {
	const res = await gwGet('user.getArl', accessToken, `sid=${sid}`);
	if (!res.ok)
		throw new ProviderError(`Deezer ARL fetch failed: HTTP ${res.status}`, 'AUTH_FAILED');
	const body = (await res.json()) as { results?: string; error?: unknown };
	if (!body.results) throw new ProviderError('Deezer returned no ARL', 'AUTH_FAILED');
	return body.results;
}

async function callGatewayRaw(
	session: DeezerSessionData,
	method: string,
	params: Record<string, unknown> = {},
): Promise<{ body: Record<string, unknown>; session: DeezerSessionData }> {
	const url = `${GW_URL}?method=${encodeURIComponent(method)}&input=3&api_version=1.0&api_token=${encodeURIComponent(session.apiToken)}`;
	const res = await fetch(url, {
		method: 'POST',
		headers: {
			'User-Agent': UA,
			Accept: '*/*',
			'Content-Type': 'application/json',
			'Accept-Language': 'en,en-US;q=0.9',
			'Content-Language': 'en',
			'X-User-IP': '1.1.1.1',
			'x-deezer-client-ip': '1.1.1.1',
			'x-deezer-user': session.userId,
			Cookie: `arl=${session.arl}; sid=${session.sid}`,
		},
		body: JSON.stringify(params),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const newSid = newSidFromHeaders(res.headers);
	if (newSid) session = { ...session, sid: newSid };
	if (!res.ok) {
		throw new ProviderError(
			`Deezer gateway HTTP ${res.status} for ${method}`,
			'PROVIDER_UNAVAILABLE',
		);
	}
	let body: Record<string, unknown>;
	try {
		body = (await res.json()) as Record<string, unknown>;
	} catch {
		throw new ProviderError(
			`Deezer gateway returned non-JSON for ${method} (blocked or challenged)`,
			'PROVIDER_UNAVAILABLE',
		);
	}
	return { body, session };
}

/** Refresh checkForm/license_token/userId from an authenticated session. */
async function refreshUserData(session: DeezerSessionData): Promise<DeezerSessionData> {
	const { body, session: s2 } = await callGatewayRaw(session, 'deezer.getUserData');
	if (body.error && Object.keys(body.error).length > 0) {
		throw new ProviderError(
			`deezer.getUserData error: ${JSON.stringify(body.error)}`,
			'AUTH_FAILED',
		);
	}
	const results = body.results as Record<string, unknown> | undefined;
	const user = results?.USER as Record<string, unknown> | undefined;
	const options = user?.OPTIONS as Record<string, unknown> | undefined;
	// The gateway has two response shapes: legacy `checkForm` at top level and
	// a newer one carrying the CSRF token as `USER_TOKEN` (with numeric
	// USER_ID). Accept both.
	const checkForm = results?.checkForm ?? results?.USER_TOKEN;
	const rawUserId = user?.USER_ID as string | number | undefined;
	const licenseToken = options?.license_token;
	const checkFormStr = typeof checkForm === 'string' ? checkForm : undefined;
	const userId = rawUserId === undefined || rawUserId === null ? undefined : String(rawUserId);
	if (
		typeof checkFormStr !== 'string' ||
		typeof userId !== 'string' ||
		typeof licenseToken !== 'string' ||
		userId === '0'
	) {
		log.warn('deezer getUserData unusable', {
			hasResults: results !== undefined,
			resultKeys: results ? Object.keys(results).slice(0, 12) : [],
			userId,
			hasCheckForm: typeof checkFormStr === 'string',
			hasLicense: typeof licenseToken === 'string',
			gatewayError: body.error ? JSON.stringify(body.error).slice(0, 200) : null,
		});
		throw new ProviderError('Deezer session data incomplete (arl expired?)', 'AUTH_FAILED');
	}
	return { ...s2, apiToken: checkFormStr, userId, licenseToken };
}

/**
 * Credential resolution order (Phase 2): the Providers UI stores encrypted
 * config in the DB; .env remains a bootstrap fallback for headless setups.
 * An ARL pasted by the user short-circuits the password grant entirely.
 */
async function credentialsFromConfig(): Promise<{
	email: string;
	password: string;
	arl?: string;
} | null> {
	try {
		const { getProviderConfig } = await import('$lib/server/providers/config');
		const cfg = await getProviderConfig<{ email?: string; password?: string; arl?: string }>(
			'deezer',
		);
		if (cfg?.arl) return { email: cfg.email ?? '', password: '', arl: cfg.arl };
		if (cfg?.email && cfg.password) return { email: cfg.email, password: cfg.password };
	} catch (err) {
		log.debug('deezer config store unavailable', { error: String(err) });
	}
	if (env.DEEZER_EMAIL && env.DEEZER_PASSWORD) {
		return { email: env.DEEZER_EMAIL, password: env.DEEZER_PASSWORD };
	}
	return null;
}

async function loginFull(): Promise<DeezerSessionData> {
	const creds = await credentialsFromConfig();
	if (!creds) {
		throw new ProviderError(
			'Deezer credentials not configured. Add them in Providers (or set DEEZER_EMAIL/DEEZER_PASSWORD).',
			'NO_CREDENTIALS',
		);
	}
	if (creds.arl) {
		// ARL provided directly — try it first; on failure fall through to the
		// password grant (the stored ARL may be stale).
		try {
			const session = await refreshUserData({
				arl: creds.arl,
				sid: await fetchSid(),
				apiToken: 'null',
				userId: '',
				licenseToken: '',
			});
			await persist(session);
			log.info('deezer session from ARL', { userId: session.userId });
			return session;
		} catch (err) {
			if (!creds.email || !creds.password) throw err;
			log.warn('stored ARL unusable, falling back to password grant', { error: String(err) });
		}
	}
	// Mirror echo-deezer-extension: up to 3 attempts of the full login chain.
	let lastError: unknown = null;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const sid = await fetchSid();
			const accessToken = await fetchAccessToken(creds.email, creds.password, sid);
			const arl = await fetchArl(accessToken, sid);
			// Post-login getUserData uses the literal token "null" (as in the
			// reference implementation); the ARL cookie carries the session.
			const session = await refreshUserData({
				arl,
				sid,
				apiToken: 'null',
				userId: '',
				licenseToken: '',
			});
			await persist(session);
			log.info('deezer login ok', { userId: session.userId });
			return session;
		} catch (err) {
			lastError = err;
			log.warn('deezer login attempt failed', { attempt, error: String(err) });
			await new Promise((r) => setTimeout(r, attempt * 1000));
		}
	}
	throw lastError instanceof ProviderError
		? lastError
		: new ProviderError(`Deezer login failed: ${String(lastError)}`, 'AUTH_FAILED');
}

/** Validated session with transparent refresh/re-login. */
export async function getDeezerSession(): Promise<DeezerSessionData> {
	if (globalForDeezer.naviDeezerSession) return globalForDeezer.naviDeezerSession;
	const persisted = await loadPersisted();
	if (persisted) {
		try {
			const fresh = await refreshUserData(persisted);
			globalForDeezer.naviDeezerSession = fresh;
			await persist(fresh);
			return fresh;
		} catch (err) {
			log.warn('persisted deezer session invalid, re-login required', { error: String(err) });
		}
	}
	const session = await loginFull();
	globalForDeezer.naviDeezerSession = session;
	return session;
}

/**
 * Authenticated gateway call with single-shot CSRF recovery:
 * "Invalid CSRF token" → refresh (or re-login) → retry once.
 */
export async function callGateway(
	method: string,
	params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	// Serialize refresh attempts across concurrent jobs.
	if (globalForDeezer.naviDeezerRefresh) await globalForDeezer.naviDeezerRefresh;
	let session = await getDeezerSession();
	let { body } = await callGatewayRaw(session, method, params);

	const err = body.error;
	if (err && typeof err === 'object' && Object.keys(err).length > 0) {
		const tokenError = (err as Record<string, unknown>)['VALID_TOKEN_REQUIRED'];
		const isCsrf = typeof tokenError === 'string' && tokenError.includes('Invalid CSRF token');
		if (!isCsrf) {
			throw new ProviderError(
				`Deezer gateway error on ${method}: ${JSON.stringify(err)}`,
				'PROVIDER_UNAVAILABLE',
			);
		}
		log.warn('deezer csrf token invalid — refreshing session', { method });
		globalForDeezer.naviDeezerRefresh = (async () => {
			try {
				globalForDeezer.naviDeezerSession = await refreshUserData(session);
				await persist(globalForDeezer.naviDeezerSession);
			} catch {
				globalForDeezer.naviDeezerSession = await loginFull();
			}
		})();
		try {
			await globalForDeezer.naviDeezerRefresh;
		} finally {
			globalForDeezer.naviDeezerRefresh = null;
		}
		session = await getDeezerSession();
		({ body } = await callGatewayRaw(session, method, params));
	}
	return body;
}

export function clearInMemorySession(): void {
	globalForDeezer.naviDeezerSession = null;
}

export function getLicenseToken(session: DeezerSessionData): string {
	return session.licenseToken;
}
