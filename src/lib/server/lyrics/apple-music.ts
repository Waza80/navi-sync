import { getDeezerSession } from '$lib/server/providers/deezer/gateway';
import type { LyricsQuery, LyricsResult, LyricsSource } from './types';

/**
 * Apple Music lyrics source, ported from
 * ancientcatz/echo-apple-music-extension:
 *   1. scrape the web player JWT from beta.music.apple.com assets
 *   2. catalog search: amp-api.music.apple.com/v1/catalog/us/search
 *   3. synced lyrics: https://lyrics.paxsenix.org/apple-music/lyrics?id=<id>
 *      → {type, content:[{text:[{text,part}], timestamp, endtime?}]}
 * The JWT is a public web-player token; no Apple account is used.
 */

const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let cachedToken: { token: string; at: number } | null = null;

async function getAppleJwt(): Promise<string> {
	if (cachedToken && Date.now() - cachedToken.at < 6 * 3600 * 1000) return cachedToken.token;
	const home = await fetch('https://beta.music.apple.com', {
		headers: { 'User-Agent': UA },
		signal: AbortSignal.timeout(15_000),
	});
	if (!home.ok) throw new Error(`apple homepage HTTP ${home.status}`);
	const body = await home.text();
	const indexMatch = /\/assets\/index~[^/]+\.js/.exec(body);
	if (!indexMatch?.[0]) throw new Error('apple index js not found');
	const js = await (
		await fetch(`https://beta.music.apple.com${indexMatch[0]}`, {
			headers: { 'User-Agent': UA },
			signal: AbortSignal.timeout(15_000),
		})
	).text();
	const tokenMatch = /eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+/.exec(js);
	if (!tokenMatch?.[0]) throw new Error('apple JWT not found');
	cachedToken = { token: tokenMatch[0], at: Date.now() };
	return cachedToken.token;
}

interface PaxSyllable {
	text: string;
	part?: boolean;
}

interface PaxLine {
	text: PaxSyllable[];
	timestamp: number;
	endtime?: number;
}

interface PaxResponse {
	type?: string;
	content?: PaxLine[];
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
			const term = encodeURIComponent(`${q.artist} ${q.title}`.trim());
			const searchRes = await fetch(
				`https://amp-api.music.apple.com/v1/catalog/us/search?term=${term}&limit=5&types=songs`,
				{
					headers: {
						Authorization: `Bearer ${jwt}`,
						Origin: 'https://music.apple.com',
						Referer: 'https://music.apple.com/',
						'User-Agent': UA,
					},
					signal: AbortSignal.timeout(15_000),
				},
			);
			if (!searchRes.ok) return null;
			const search = (await searchRes.json()) as {
				results?: {
					songs?: {
						data?: Array<{
							id: string;
							attributes?: {
								name?: string;
								artistName?: string;
								durationInMillis?: number;
							};
						}>;
					};
				};
			};
			const songs = search.results?.songs?.data ?? [];
			if (songs.length === 0) return null;
			// Pick best match by name similarity (+/-3s duration when known).
			const needle = q.title.toLowerCase();
			const ranked = [...songs].sort((a, b) => {
				const score = (s: {
					attributes?: { name?: string; durationInMillis?: number };
				}): number => {
					let v = 0;
					if ((s.attributes?.name ?? '').toLowerCase().includes(needle)) v += 10;
					if (q.durationSec && s.attributes?.durationInMillis) {
						const diff = Math.abs(s.attributes.durationInMillis / 1000 - q.durationSec);
						if (diff <= 3) v += 5;
					}
					return v;
				};
				return score(b) - score(a);
			});
			const best = ranked[0];
			if (!best?.id) return null;

			const lyricRes = await fetch(
				`https://lyrics.paxsenix.org/apple-music/lyrics?id=${best.id}`,
				{
					headers: { 'User-Agent': UA, Accept: 'application/json' },
					signal: AbortSignal.timeout(15_000),
				},
			);
			if (!lyricRes.ok) return null;
			const payload = (await lyricRes.json()) as PaxResponse | PaxLine[];
			const lines = Array.isArray(payload) ? payload : (payload.content ?? []);
			const synced = paxLinesToLrc(lines);
			if (!synced) return null;
			return { synced, plain: null };
		} catch {
			return null;
		}
	},
};

export { getDeezerSession };
