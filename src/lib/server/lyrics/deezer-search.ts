import { deezerProvider } from '$lib/server/providers/deezer';
import { fetchDeezerLyrics } from './deezer-pipe';
import { artistsMatch, durationClose, normalizeForMatch, titlesMatch } from './match';
import type { LyricsQuery, LyricsResult, LyricsSource } from './types';
import type { TrackMeta } from '$lib/server/providers/types';

/**
 * Deezer fallback for tracks that did NOT come from Deezer.
 *
 * `deezer-pipe` needs a Deezer SNG_ID, which only Deezer-sourced rows carry. But
 * Deezer's synchronized catalogue also covers plenty of local/Tidal/uploaded
 * tracks — measured on 40 such rows, 33 resolved to an exact Deezer recording
 * and 6 of those had synced lyrics no other source produced.
 *
 * The search is the risky part, so the gate is strict: ISRC equality when both
 * sides have one, otherwise title + artist + duration within 3 s. A miss costs
 * one search; a wrong match would put another song's words on the file, which is
 * worse than having none.
 */

const MAX_DURATION_DRIFT_SEC = 3;

/** Exported for tests: choose the one candidate that is provably this recording. */
export function pickDeezerMatch<T extends TrackMeta>(candidates: T[], q: LyricsQuery): T | null {
	if (q.isrc) {
		const byIsrc = candidates.find((c) => c.isrc?.toUpperCase() === q.isrc?.toUpperCase());
		if (byIsrc) return byIsrc;
	}

	let best: { meta: T; score: number } | null = null;
	for (const candidate of candidates) {
		if (!candidate.providerTrackId) continue;
		if (!titlesMatch(candidate.title, q.title)) continue;
		if (!artistsMatch(candidate.artist, q.artist)) continue;
		if (!durationClose(candidate.durationSec, q.durationSec, MAX_DURATION_DRIFT_SEC)) continue;

		let score = 0;
		if (normalizeForMatch(candidate.title) === normalizeForMatch(q.title)) score += 10;
		if (normalizeForMatch(candidate.artist) === normalizeForMatch(q.artist)) score += 4;
		if (candidate.album && q.album && titlesMatch(candidate.album, q.album)) score += 2;
		if (candidate.durationSec && q.durationSec) {
			score += Math.max(0, 3 - Math.abs(candidate.durationSec - q.durationSec));
		}
		if (!best || score > best.score) best = { meta: candidate, score };
	}
	return best?.meta ?? null;
}

export const deezerSearchSource: LyricsSource = {
	id: 'deezer-search',
	displayName: 'Deezer (search + synchronized)',

	async fetch(q: LyricsQuery): Promise<LyricsResult | null> {
		// Deezer-sourced rows already go through the exact-id source.
		if (q.providerTrackId) return null;
		try {
			const candidates = await deezerProvider.search(`${q.artist} ${q.title}`.trim());
			const match = pickDeezerMatch(candidates, q);
			if (!match?.providerTrackId) return null;
			return await fetchDeezerLyrics(match.providerTrackId);
		} catch {
			return null;
		}
	},
};
