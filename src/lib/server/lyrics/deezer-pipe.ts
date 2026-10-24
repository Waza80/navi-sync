import { getDeezerSession } from '$lib/server/providers/deezer/gateway';
import type { LyricsQuery, LyricsResult, LyricsSource } from './types';
import { fetchWithRetry } from './http';

/**
 * Deezer synchronized-lyrics source, ported from
 * LuftVerbot/echo-deezer-extension DeezerApi.lyrics():
 *   POST auth.deezer.com/login/arl (cookie arl) → JWT
 *   POST pipe.deezer.com/api (GraphQL SynchronizedTrackLyrics, Bearer JWT)
 *
 * Two defects made this source return null for EVERY track:
 *
 *  1. `lyrics.text` is a string, not the `string[]` the port assumed. The
 *     `.join('\n')` threw, the catch swallowed it, and even tracks with
 *     synchronized lines reported "no lyrics". Measured 2026-10-21: 27 of 31
 *     plain Deezer tracks had synced lines the app never saw.
 *  2. The JWT was re-fetched for every track. It is valid for minutes, so
 *     caching it halves the request count and the chance of a rate-limit.
 */

interface SyncLine {
	lrcTimestamp?: string;
	line?: string;
	milliseconds?: number;
	duration?: number;
}

interface PipeResponse {
	data?: {
		track?: {
			lyrics?: {
				/** The live API returns a string here; older responses returned lines. */
				text?: string | string[] | null;
				synchronizedLines?: SyncLine[] | null;
			} | null;
		} | null;
	} | null;
	errors?: unknown;
}

const GRAPHQL_QUERY = `query SynchronizedTrackLyrics($trackId: String!) {
  track(trackId: $trackId) {
    id
    isExplicit
    lyrics {
      id
      copyright
      text
      writers
      synchronizedLines {
        lrcTimestamp
        line
        milliseconds
        duration
        __typename
      }
      __typename
    }
    __typename
  }
}`;

const JWT_TTL_MS = 10 * 60_000;
let cachedJwt: { jwt: string; at: number } | null = null;

async function getJwt(): Promise<string | null> {
	if (cachedJwt && Date.now() - cachedJwt.at < JWT_TTL_MS) return cachedJwt.jwt;
	const session = await getDeezerSession();
	const res = await fetchWithRetry(
		'https://auth.deezer.com/login/arl?jo=p&rto=c&i=c',
		{
			method: 'POST',
			headers: { Cookie: `arl=${session.arl}; sid=${session.sid}` },
			body: '',
		},
		{ timeoutMs: 12_000, retries: 2 },
	);
	if (!res?.ok) return null;
	const body = (await res.json()) as { jwt?: string };
	if (!body.jwt) return null;
	cachedJwt = { jwt: body.jwt, at: Date.now() };
	return body.jwt;
}

async function callPipe(trackId: string, jwt: string): Promise<Response | null> {
	return fetchWithRetry(
		'https://pipe.deezer.com/api',
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${jwt}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				operationName: 'SynchronizedTrackLyrics',
				query: GRAPHQL_QUERY,
				variables: { trackId },
			}),
		},
		{ timeoutMs: 12_000, retries: 2 },
	);
}

/** Fetches lyrics for one Deezer track id. Exported so the search fallback can reuse it. */
export async function fetchDeezerLyrics(trackId: string): Promise<LyricsResult | null> {
	let jwt = await getJwt();
	if (!jwt) return null;

	let res = await callPipe(trackId, jwt);
	if (res && (res.status === 401 || res.status === 403)) {
		// The cached JWT aged out between calls — refresh once, then give up.
		cachedJwt = null;
		jwt = await getJwt();
		if (!jwt) return null;
		res = await callPipe(trackId, jwt);
	}
	if (!res?.ok) return null;

	const body = (await res.json()) as PipeResponse;
	if (body.errors) return null;
	const lyrics = body.data?.track?.lyrics;
	if (!lyrics) return null;

	const synced = linesToLrc(lyrics.synchronizedLines ?? []);
	const plain = plainText(lyrics.text);
	if (!synced && !plain) return null;
	return { synced, plain };
}

/** The field is a string in the live API and an array in some older payloads. */
export function plainText(text: string | string[] | null | undefined): string | null {
	if (!text) return null;
	const joined = Array.isArray(text) ? text.join('\n') : text;
	const normalized = joined.replace(/\r\n/g, '\n').trim();
	return normalized.length > 0 ? normalized : null;
}

/**
 * Deezer returns EITHER `milliseconds` OR a preformatted `lrcTimestamp`
 * (`[mm:ss.cc]`), and in practice `milliseconds` is frequently absent while
 * `lrcTimestamp` is present. Reading only `milliseconds` therefore stamped every
 * line `[00:00.00]` — a syntactically valid but useless LRC, which Navidrome
 * then discarded. So prefer the parsed integer, and fall back to the supplied
 * timestamp string verbatim.
 */
export function linesToLrc(lines: SyncLine[]): string | null {
	const out: string[] = [];
	for (const line of lines) {
		const text = line.line ?? '';
		const ms = line.milliseconds;
		let stamp: string;
		if (typeof ms === 'number' && Number.isFinite(ms)) {
			const minutes = Math.floor(ms / 60000);
			const seconds = Math.floor((ms % 60000) / 1000);
			const hundredths = Math.floor((ms % 1000) / 10);
			stamp = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`;
		} else if (line.lrcTimestamp && /^\[[\d:.]+\]/.test(line.lrcTimestamp)) {
			stamp = line.lrcTimestamp.slice(0, line.lrcTimestamp.indexOf(']') + 1);
		} else {
			// No usable timing at all — an untimed line carries no sync value.
			continue;
		}
		out.push(`${stamp}${text}`);
	}
	return out.length > 0 ? out.join('\n') : null;
}

export const deezerPipeSource: LyricsSource = {
	id: 'deezer-pipe',
	displayName: 'Deezer (synchronized)',

	async fetch(q: LyricsQuery): Promise<LyricsResult | null> {
		if (!q.providerTrackId) return null;
		try {
			return await fetchDeezerLyrics(q.providerTrackId);
		} catch {
			return null;
		}
	},
};
