import { dirname, join } from 'node:path';
import { stat, writeFile } from 'node:fs/promises';
import { logger } from '$lib/server/logger';

const log = logger;

export interface CoverTrack {
	filePath: string | null;
	artist: string;
	album: string | null;
}

export interface CoverBackfillReport {
	/** Album folders examined. */
	checked: number;
	/** Canonical cover.jpg files written. */
	backfilled: number;
}

/**
 * Best-effort album art via the public Deezer search API (no auth required).
 * Returns JPEG bytes or null — cover backfill must never fail a repair.
 */
export async function fetchAlbumArt(artist: string, album: string): Promise<Buffer | null> {
	try {
		const q = encodeURIComponent(`${artist} ${album}`.trim());
		const res = await fetch(`https://api.deezer.com/search/album?q=${q}&limit=1`, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { data?: Array<{ cover_xl?: string }> };
		const url = body.data?.[0]?.cover_xl;
		if (!url) return null;
		const img = await fetch(url, { signal: AbortSignal.timeout(15_000) });
		if (!img.ok) return null;
		const buf = Buffer.from(await img.arrayBuffer());
		if (buf.length < 1024 || buf.length > 15 * 1024 * 1024) return null;
		return buf;
	} catch (err) {
		log.debug('album art fetch failed', { artist, album, error: String(err) });
		return null;
	}
}

const RECOGNIZED_ART = ['cover.jpg', 'folder.jpg', 'front.jpg'];

/**
 * Ensure every album folder has a Navidrome-recognized cover. Deduped
 * variants like "cover (2).jpg" are invisible to Navidrome, so a canonical
 * cover.jpg is (re)created when none of the recognized names exists.
 */
export async function backfillAlbumCovers(tracks: CoverTrack[]): Promise<CoverBackfillReport> {
	const seen = new Set<string>();
	let checked = 0;
	let backfilled = 0;
	for (const t of tracks) {
		if (!t.filePath || !t.album) continue;
		const dir = dirname(t.filePath);
		if (seen.has(dir)) continue;
		seen.add(dir);
		checked++;
		const hasArt = await Promise.any(
			RECOGNIZED_ART.map((n) =>
				stat(join(dir, n)).then(
					() => true,
					() => Promise.reject(new Error('missing')),
				),
			),
		).catch(() => false);
		if (hasArt) continue;
		const art = await fetchAlbumArt(t.artist, t.album);
		if (!art) continue;
		await writeFile(join(dir, 'cover.jpg'), art).catch(() => undefined);
		backfilled++;
		log.info('album cover backfilled', { dir });
	}
	return { checked, backfilled };
}
