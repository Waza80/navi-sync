import { getDeezerSession } from '$lib/server/providers/deezer/gateway';
import type { LyricsQuery, LyricsResult, LyricsSource } from './types';

/**
 * Deezer synchronized-lyrics source (priority 2), ported from
 * LuftVerbot/echo-deezer-extension DeezerApi.lyrics():
 *   POST auth.deezer.com/login/arl (cookie arl) → JWT
 *   POST pipe.deezer.com/api (GraphQL SynchronizedTrackLyrics, Bearer JWT)
 * Only used when a Deezer session exists; silently returns null otherwise.
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
				text?: string[];
				synchronizedLines?: SyncLine[];
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

export const deezerPipeSource: LyricsSource = {
	id: 'deezer-pipe',
	displayName: 'Deezer (synchronized)',

	async fetch(q: LyricsQuery): Promise<LyricsResult | null> {
		if (!q.providerTrackId) return null;
		try {
			const session = await getDeezerSession();
			const authRes = await fetch('https://auth.deezer.com/login/arl?jo=p&rto=c&i=c', {
				method: 'POST',
				headers: { Cookie: `arl=${session.arl}; sid=${session.sid}` },
				body: '',
				signal: AbortSignal.timeout(15_000),
			});
			if (!authRes.ok) return null;
			const authBody = (await authRes.json()) as { jwt?: string };
			if (!authBody.jwt) return null;

			const pipeRes = await fetch('https://pipe.deezer.com/api', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${authBody.jwt}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					operationName: 'SynchronizedTrackLyrics',
					query: GRAPHQL_QUERY,
					variables: { trackId: q.providerTrackId },
				}),
				signal: AbortSignal.timeout(15_000),
			});
			if (!pipeRes.ok) return null;
			const body = (await pipeRes.json()) as PipeResponse;
			const lyrics = body.data?.track?.lyrics;
			if (!lyrics) return null;

			const synced = linesToLrc(lyrics.synchronizedLines ?? []);
			const plain = lyrics.text && lyrics.text.length > 0 ? lyrics.text.join('\n') : null;
			if (!synced && !plain) return null;
			return { synced, plain };
		} catch {
			return null;
		}
	},
};

/**
 * Deezer returns EITHER `milliseconds` OR a preformatted `lrcTimestamp`
 * (`[mm:ss.cc]`), and in practice `milliseconds` is frequently absent while
 * `lrcTimestamp` is present. Reading only `milliseconds` therefore stamped every
 * line `[00:00.00]` — a syntactically valid but useless LRC, which Navidrome
 * then discarded. So prefer the parsed integer, and fall back to the supplied
 * timestamp string verbatim.
 */
function linesToLrc(lines: SyncLine[]): string | null {
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
