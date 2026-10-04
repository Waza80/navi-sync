import { logger } from '$lib/server/logger';
import { pickStrict } from '../match';
import type { MetadataPatch, MetadataQuery, MetadataSource } from '../types';

/**
 * Apple Music / iTunes Search API — **cover art only**.
 *
 * Artwork is the one field where a near-certain answer beats a blank field: a
 * wrong cover is far less harmful than a wrong album (which would rewrite the
 * file's folder), and Apple has by far the best artwork coverage. Album, year
 * and track data are deliberately NOT taken from here — MusicBrainz is
 * authoritative for those.
 *
 * Docs: https://performance-partners.apple.com/search-api
 */

const log = logger;
const ITUNES = 'https://itunes.apple.com/search';
const TIMEOUT_MS = 15_000;

interface ItunesTrack {
	trackId?: number;
	trackName?: string;
	artistName?: string;
	collectionName?: string;
	artworkUrl100?: string;
	trackTimeMillis?: number;
}

/** 100x100 previews only — swap the suffix for the full-size asset. */
function upscale(artUrl: string | undefined): string | null {
	if (!artUrl) return null;
	return artUrl.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/1200x1200bb.$1');
}

async function fetchJson(url: string): Promise<ItunesTrack[] | null> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) return null;
		const body = (await res.json()) as { results?: ItunesTrack[] };
		return body.results ?? [];
	} catch (err) {
		log.debug('itunes request failed', { error: String(err) });
		return null;
	}
}

export const itunesSource: MetadataSource = {
	id: 'itunes',
	displayName: 'Apple Music',
	requiresAuth: false,
	async lookup(query: MetadataQuery): Promise<MetadataPatch | null> {
		// Only ever consulted for artwork.
		if (!query.needed.includes('coverUrl')) return null;
		const term = encodeURIComponent(`${query.artist} ${query.title}`.trim());
		const results = await fetchJson(`${ITUNES}?term=${term}&entity=song&limit=5`);
		if (!results || results.length === 0) return null;
		const strict = pickStrict(
			{
				title: query.title,
				artist: query.artist,
				album: query.album,
				durationSec: query.durationSec,
			},
			results
				.filter((r) => r.trackName && r.artistName)
				.map((r) => ({
					title: r.trackName ?? '',
					artist: r.artistName ?? '',
					album: r.collectionName ?? null,
					durationSec:
						typeof r.trackTimeMillis === 'number'
							? Math.round(r.trackTimeMillis / 1000)
							: null,
				})),
		);
		if (!strict) return null;
		const best = results.find(
			(r) => r.trackName === strict.title && r.artistName === strict.artist,
		);
		const coverUrl = upscale(best?.artworkUrl100);
		return coverUrl ? { coverUrl } : null;
	},
};
