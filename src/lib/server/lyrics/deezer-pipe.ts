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

function linesToLrc(lines: SyncLine[]): string | null {
	const out: string[] = [];
	for (const line of lines) {
		const text = line.line ?? '';
		const ms = line.milliseconds ?? 0;
		const minutes = Math.floor(ms / 60000);
		const seconds = Math.floor((ms % 60000) / 1000);
		const hundredths = Math.floor((ms % 1000) / 10);
		out.push(
			`[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]${text}`,
		);
	}
	return out.length > 0 ? out.join('\n') : null;
}
