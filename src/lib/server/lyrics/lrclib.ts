import type { LyricsQuery, LyricsResult, LyricsSource } from './types';
import { artistsMatch, durationClose, titlesMatch } from './match';
import { fetchWithRetry } from './http';

/**
 * LRCLIB source. API: https://lrclib.net
 *   GET /api/get?artist_name&track_name&album_name&duration → best exact match
 *   GET /api/search?track_name&artist_name                  → ranked list
 * Synced lyrics (.lrc) are strongly preferred over plain text.
 *
 * Two measured defects in the original port:
 *
 *  - `/api/search` returned 503 on 54 of 138 calls. `!res.ok → null` turned
 *    that transient load into a permanent "this track has no lyrics", which is
 *    why failed rows were retried for weeks. It now retries with backoff.
 *  - `pick()` fell back to `usable.find(synced)` when no record was within
 *    ±3 s, *ignoring duration entirely*. That is how a live version or a
 *    different edit gets stamped onto a studio track. Distance is now bounded.
 */

const BASE = 'https://lrclib.net';
const UA = 'NaviSync/0.1.0 (self-hosted Navidrome companion)';
/** First pass: a different master is usually within a second or two. */
const STRICT_DURATION_SEC = 3;
/** Second pass: tolerate a longer intro/outro, but not a different recording. */
const RELAXED_DURATION_SEC = 8;

export interface LrcLibRecord {
	id: number;
	trackName: string;
	artistName: string;
	albumName?: string | null;
	duration: number;
	instrumental: boolean;
	plainLyrics: string | null;
	syncedLyrics: string | null;
}

async function getJson(url: string): Promise<unknown> {
	const res = await fetchWithRetry(
		url,
		{ headers: { 'User-Agent': UA, Accept: 'application/json' } },
		{ timeoutMs: 10_000, retries: 2 },
	);
	if (!res?.ok) return null;
	return res.json().catch(() => null);
}

/**
 * Exported for tests. Requires the record to describe the same song, and when
 * the duration is known requires it to be close — there is no path that
 * accepts an arbitrarily distant record.
 */
export function pickLrclibRecord(records: LrcLibRecord[], q: LyricsQuery): LyricsResult | null {
	const usable = records.filter(
		(r) =>
			!r.instrumental &&
			(r.syncedLyrics || r.plainLyrics) &&
			titlesMatch(r.trackName, q.title) &&
			artistsMatch(r.artistName, q.artist),
	);
	if (usable.length === 0) return null;

	const rank = (r: LrcLibRecord) => (r.syncedLyrics ? 0 : 1);
	const dur = q.durationSec;
	if (dur) {
		const strict = usable.filter((r) => durationClose(r.duration, dur, STRICT_DURATION_SEC));
		if (strict.length > 0) {
			const best = [...strict].sort((a, b) => rank(a) - rank(b))[0];
			return { synced: best.syncedLyrics ?? null, plain: best.plainLyrics ?? null };
		}
		const relaxed = usable.filter((r) => durationClose(r.duration, dur, RELAXED_DURATION_SEC));
		if (relaxed.length > 0) {
			const best = [...relaxed].sort((a, b) => rank(a) - rank(b))[0];
			return { synced: best.syncedLyrics ?? null, plain: best.plainLyrics ?? null };
		}
		return null;
	}

	const best = [...usable].sort((a, b) => rank(a) - rank(b))[0];
	return { synced: best.syncedLyrics ?? null, plain: best.plainLyrics ?? null };
}

export const lrclibSource: LyricsSource = {
	id: 'lrclib',
	displayName: 'LRCLIB',

	async fetch(q: LyricsQuery): Promise<LyricsResult | null> {
		const params = new URLSearchParams({
			artist_name: q.artist,
			track_name: q.title,
		});
		if (q.album) params.set('album_name', q.album);
		if (q.durationSec) params.set('duration', String(Math.round(q.durationSec)));

		// 1) exact match endpoint
		const exact = await getJson(`${BASE}/api/get?${params.toString()}`);
		if (exact && typeof exact === 'object') {
			const rec = exact as LrcLibRecord;
			if (rec.instrumental) {
				// Only the exact endpoint can say this with confidence. It is not a
				// failure to retry; there will never be lyrics for an instrumental.
				return { synced: null, plain: null, instrumental: true };
			}
			if (rec.syncedLyrics || rec.plainLyrics) {
				return { synced: rec.syncedLyrics ?? null, plain: rec.plainLyrics ?? null };
			}
		}

		// 2) search endpoint (fallback). Transient 503s are retried by getJson;
		// when it still fails, null means "unknown", not "no lyrics".
		const searchParams = new URLSearchParams({ track_name: q.title, artist_name: q.artist });
		const list = await getJson(`${BASE}/api/search?${searchParams.toString()}`);
		if (Array.isArray(list)) return pickLrclibRecord(list as LrcLibRecord[], q);
		return null;
	},
};
