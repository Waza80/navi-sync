import type { LyricsQuery, LyricsResult, LyricsSource } from './types';

/**
 * LRCLIB source (priority 1). API: https://lrclib.net
 *   GET /api/get?artist_name&track_name&album_name&duration → best exact match
 *   GET /api/search?track_name&artist_name                  → ranked list
 * Synced lyrics (.lrc) are strongly preferred over plain text.
 */

const BASE = 'https://lrclib.net';
const UA = 'NaviSync/0.1.0 (self-hosted Navidrome companion)';

interface LrcLibRecord {
	id: number;
	trackName: string;
	artistName: string;
	albumName?: string | null;
	duration: number;
	instrumental: boolean;
	plainLyrics: string | null;
	syncedLyrics: string | null;
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': UA, Accept: 'application/json' },
			signal,
		});
		if (res.status === 404) return null;
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

function pick(records: LrcLibRecord[], q: LyricsQuery): LyricsResult | null {
	const usable = records.filter((r) => !r.instrumental && (r.syncedLyrics || r.plainLyrics));
	if (usable.length === 0) return null;
	const dur = q.durationSec;
	if (dur) {
		const near = usable.filter((r) => Math.abs(r.duration - dur) <= 3);
		if (near.length > 0) {
			const best = near.find((r) => r.syncedLyrics) ?? near[0];
			return best
				? { synced: best.syncedLyrics ?? null, plain: best.plainLyrics ?? null }
				: null;
		}
	}
	// Prefer synced; within same sync-ness, keep LRCLIB ranking (input order).
	const best = usable.find((r) => r.syncedLyrics) ?? usable[0];
	if (!best) return null;
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
		const exact = await getJson(
			`${BASE}/api/get?${params.toString()}`,
			AbortSignal.timeout(10_000),
		);
		if (exact && typeof exact === 'object') {
			const rec = exact as LrcLibRecord;
			if (!rec.instrumental && (rec.syncedLyrics || rec.plainLyrics)) {
				return { synced: rec.syncedLyrics ?? null, plain: rec.plainLyrics ?? null };
			}
		}

		// 2) search endpoint (fallback)
		const searchParams = new URLSearchParams({ track_name: q.title, artist_name: q.artist });
		const list = await getJson(
			`${BASE}/api/search?${searchParams.toString()}`,
			AbortSignal.timeout(10_000),
		);
		if (Array.isArray(list)) {
			return pick(list as LrcLibRecord[], q);
		}
		return null;
	},
};
