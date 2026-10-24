import type { LyricsQuery, LyricsResult, LyricsSource } from './types';
import { artistsMatch, durationClose, normalizeForMatch, titlesMatch } from './match';
import { fetchWithRetry } from './http';

/**
 * Apple Music lyrics source, ported from
 * ancientcatz/echo-apple-music-extension:
 *   1. scrape the web player JWT from beta.music.apple.com assets
 *   2. catalog lookup by ISRC (exact) or search (strict fallback)
 *   3. synced lyrics: https://lyrics.paxsenix.org/apple-music/lyrics?id=<id>
 *
 * Two accuracy changes from the original port:
 *
 *  - It looks the recording up by ISRC when one is known
 *    (`/v1/catalog/us/songs?filter[isrc]=…`), so it can never pick a cover.
 *  - The search fallback requires the artist to match and the duration to be
 *    close. The old code gave +10 for a title substring and +5 for duration and
 *    never looked at the artist — "Creep" by anyone scored the same.
 *
 * The Pax backend is the weak link (measured 502/503 on 123 of 133 calls), so
 * it has a circuit breaker: after repeated failures the source stops paying the
 * timeout cost for every queued track and lets the other sources answer.
 */

const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PAX_FAILURE_THRESHOLD = 6;
const PAX_COOLDOWN_MS = 5 * 60_000;

let cachedToken: { token: string; at: number } | null = null;
let paxFailures = 0;
let paxDisabledUntil = 0;

interface AppleSong {
	id: string;
	attributes?: {
		name?: string;
		artistName?: string;
		albumName?: string;
		durationInMillis?: number;
		isrc?: string;
	};
}

interface PaxSyllable {
	text: string;
	part?: boolean;
}

export interface PaxLine {
	text: PaxSyllable[];
	timestamp: number;
	endtime?: number;
}

interface PaxResponse {
	type?: string;
	content?: PaxLine[];
}

function appleHeaders(jwt: string): Record<string, string> {
	return {
		Authorization: `Bearer ${jwt}`,
		Origin: 'https://music.apple.com',
		Referer: 'https://music.apple.com/',
		'User-Agent': UA,
	};
}

async function getAppleJwt(): Promise<string | null> {
	if (cachedToken && Date.now() - cachedToken.at < 6 * 3600 * 1000) return cachedToken.token;

	const home = await fetchWithRetry(
		'https://beta.music.apple.com',
		{ headers: { 'User-Agent': UA } },
		{ timeoutMs: 12_000, retries: 1 },
	);
	if (!home?.ok) return null;
	const body = await home.text();
	const indexMatch = /\/assets\/index~[^/]+\.js/.exec(body);
	if (!indexMatch?.[0]) return null;

	const js = await fetchWithRetry(
		`https://beta.music.apple.com${indexMatch[0]}`,
		{ headers: { 'User-Agent': UA } },
		{ timeoutMs: 12_000, retries: 1 },
	);
	if (!js?.ok) return null;
	const tokenMatch = /eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+/.exec(await js.text());
	if (!tokenMatch?.[0]) return null;
	cachedToken = { token: tokenMatch[0], at: Date.now() };
	return cachedToken.token;
}

async function lookupByIsrc(jwt: string, isrc: string): Promise<AppleSong[]> {
	const res = await fetchWithRetry(
		`https://amp-api.music.apple.com/v1/catalog/us/songs?filter[isrc]=${encodeURIComponent(isrc)}&limit=5`,
		{ headers: appleHeaders(jwt) },
		{ timeoutMs: 10_000, retries: 1 },
	);
	if (!res?.ok) return [];
	const json = (await res.json()) as { data?: AppleSong[] };
	return json.data ?? [];
}

async function searchSongs(jwt: string, q: LyricsQuery): Promise<AppleSong[]> {
	const term = encodeURIComponent(`${q.artist} ${q.title}`.trim());
	const res = await fetchWithRetry(
		`https://amp-api.music.apple.com/v1/catalog/us/search?term=${term}&limit=5&types=songs`,
		{ headers: appleHeaders(jwt) },
		{ timeoutMs: 10_000, retries: 1 },
	);
	if (!res?.ok) return [];
	const search = (await res.json()) as {
		results?: { songs?: { data?: AppleSong[] } };
	};
	return search.results?.songs?.data ?? [];
}

/** Exported for tests: pick the one song that is provably the same recording. */
export function pickAppleSong(songs: AppleSong[], q: LyricsQuery): AppleSong | null {
	if (q.isrc) {
		const byIsrc = songs.find(
			(s) => s.attributes?.isrc?.toUpperCase() === q.isrc?.toUpperCase(),
		);
		if (byIsrc) return byIsrc;
	}

	let best: { song: AppleSong; score: number } | null = null;
	for (const song of songs) {
		const a = song.attributes;
		if (!a) continue;
		if (!titlesMatch(a.name ?? '', q.title)) continue;
		if (!artistsMatch(a.artistName ?? '', q.artist)) continue;

		const songDuration = a.durationInMillis ? a.durationInMillis / 1000 : null;
		if (!durationClose(songDuration, q.durationSec, 8)) continue;

		let score = 0;
		if (normalizeForMatch(a.name ?? '') === normalizeForMatch(q.title)) score += 10;
		if (a.artistName && normalizeForMatch(a.artistName) === normalizeForMatch(q.artist))
			score += 4;
		if (songDuration && q.durationSec && Math.abs(songDuration - q.durationSec) <= 3)
			score += 5;
		if (q.album && a.albumName && titlesMatch(a.albumName, q.album)) score += 2;

		if (!best || score > best.score) best = { song, score };
	}
	return best?.song ?? null;
}

async function fetchPaxLines(songId: string): Promise<PaxLine[] | null> {
	if (Date.now() < paxDisabledUntil) return null;

	const res = await fetchWithRetry(
		`https://lyrics.paxsenix.org/apple-music/lyrics?id=${encodeURIComponent(songId)}`,
		{ headers: { 'User-Agent': UA, Accept: 'application/json' } },
		// Pax is frequently 502; one retry rescues the intermittent case without
		// making a genuinely dead backend cost 30 seconds per track.
		{ timeoutMs: 8000, retries: 1 },
	);
	if (!res?.ok) {
		paxFailures += 1;
		if (paxFailures >= PAX_FAILURE_THRESHOLD) {
			paxDisabledUntil = Date.now() + PAX_COOLDOWN_MS;
			paxFailures = 0;
		}
		return null;
	}
	paxFailures = 0;

	const payload = (await res.json()) as PaxResponse | PaxLine[];
	const lines = Array.isArray(payload) ? payload : (payload.content ?? []);
	return lines.length > 0 ? lines : null;
}

/** Builds an LRC document from Pax line data. */
export function paxLinesToLrc(lines: PaxLine[]): string | null {
	if (lines.length === 0) return null;
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const text = line.text
			.map((syl) => syl.text + (syl.part ? '' : ' '))
			.join('')
			.replace(/\s+/gu, ' ')
			.trim();
		const ms = Math.max(0, line.timestamp);
		const minutes = Math.floor(ms / 60000);
		const seconds = Math.floor((ms % 60000) / 1000);
		const hundredths = Math.floor((ms % 1000) / 10);
		out.push(
			`[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]${text}`,
		);
		void line.endtime;
	}
	return out.join('\n');
}

export const appleMusicSource: LyricsSource = {
	id: 'apple-music',
	displayName: 'Apple Music (Pax)',

	async fetch(q: LyricsQuery): Promise<LyricsResult | null> {
		try {
			const jwt = await getAppleJwt();
			if (!jwt) return null;

			let songs = q.isrc ? await lookupByIsrc(jwt, q.isrc) : [];
			if (songs.length === 0) songs = await searchSongs(jwt, q);
			const best = pickAppleSong(songs, q);
			if (!best?.id) return null;

			const lines = await fetchPaxLines(best.id);
			if (!lines) return null;
			const synced = paxLinesToLrc(lines);
			if (!synced) return null;
			return { synced, plain: null };
		} catch {
			return null;
		}
	},
};
