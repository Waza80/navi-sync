import { logger } from '$lib/server/logger';
import { pickStrict } from '../match';
import type { MetadataPatch, MetadataQuery, MetadataSource } from '../types';

/**
 * Deezer catalog metadata (public search API — no auth, no key).
 *
 * Deezer is the best of the three on artwork reach, and measured 11/12 on the
 * library catalogue versus 8/12 for MusicBrainz. It is also the source already
 * trusted for album art backfill, so reusing it here keeps cover handling in one
 * place.
 *
 * Candidates go through `pickStrict` exactly like the other sources — Deezer is
 * full of live bootlegs and remix entries under the same title, and writing one
 * of those onto a real file would be worse than leaving the field blank.
 */

const log = logger;
const DEEZER = 'https://api.deezer.com/search';
const DEEZER_ALBUM = 'https://api.deezer.com/album';
const TIMEOUT_MS = 15_000;

interface DeezerTrack {
	id?: number;
	title?: string;
	title_short?: string;
	isrc?: string;
	duration?: number;
	artist?: { name?: string };
	album?: { id?: number; title?: string; cover_xl?: string; release_date?: string };
}

interface DeezerAlbum {
	id?: number;
	title?: string;
	genres?: { data?: Array<{ name?: string }> };
}

/**
 * Album genres from Deezer.
 *
 * The track search payload carries NO genre — the field only exists on the album
 * endpoint — which is why `genre` was empty for every row in the library: it was
 * declared in MetadataField and requested by neededFieldsFor, and NO source
 * produced it. Tidal documents that it never sets genre; MusicBrainz's genre list
 * is not in the recording payload we fetch; iTunes does not expose it here.
 *
 * One extra request per album, only when genre is actually wanted, which is what
 * `needed` is for.
 */
async function albumGenres(albumId: number | undefined): Promise<string | null> {
	if (!albumId) return null;
	try {
		const res = await fetch(`${DEEZER_ALBUM}/${albumId}`, {
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const album = (await res.json()) as DeezerAlbum;
		const names = (album?.genres?.data ?? [])
			.map((g) => g.name?.trim())
			.filter((n): n is string => typeof n === 'string' && n.length > 0);
		if (names.length === 0) return null;
		// Keep it a usable tag. Deezer returns its genre tree flattened: RAM yields
		// "Electro / Electro Pop/Electro Rock / Techno/House / Dance / Pop /
		// International Pop / Rock / R&B / Disco / Soul & Funk" — 160 characters of
		// noise for one GENRE field. The first entry is the most specific (Discovery
		// gives "Electro", not "Dance"), so take that, plus a second only when it is
		// short and genuinely distinct.
		const primary = names[0];
		const secondary = names[1];
		return secondary && secondary !== primary && secondary.length <= 24
			? `${primary} / ${secondary}`
			: primary;
	} catch {
		return null;
	}
}

async function fetchJson(url: string): Promise<DeezerTrack[] | null> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) return null;
		const body = (await res.json()) as { data?: DeezerTrack[] };
		return body.data ?? [];
	} catch (err) {
		log.debug('deezer request failed', { error: String(err) });
		return null;
	}
}

export const deezerSource: MetadataSource = {
	id: 'deezer',
	displayName: 'Deezer',
	requiresAuth: false,
	async lookup(query: MetadataQuery): Promise<MetadataPatch | null> {
		if (query.needed.length === 0) return null;
		const term = encodeURIComponent(`${query.artist} ${query.title}`.trim());
		const results = await fetchJson(`${DEEZER}?q=${term}&limit=8`);
		if (!results || results.length === 0) return null;

		const candidates = results.map((t) => ({
			title: t.title_short ?? t.title ?? '',
			artist: t.artist?.name ?? '',
			album: t.album?.title ?? null,
			durationSec: t.duration ?? null,
		}));
		const best = pickStrict(
			{
				title: query.title,
				artist: query.artist,
				album: query.album,
				durationSec: query.durationSec,
			},
			candidates,
		);
		if (!best) return null;
		const hit = results.find((t) => (t.title_short ?? t.title) === best.title);
		return hit ? await toPatch(hit, query) : null;
	},
};

async function toPatch(track: DeezerTrack, query: MetadataQuery): Promise<MetadataPatch | null> {
	const need = new Set(query.needed);
	const patch: MetadataPatch = {};
	const album = track.album?.title ?? null;
	if (need.has('album') && album) patch.album = album;
	// Deezer's per-track "artist" is the performer, which is the album artist for
	// the overwhelming majority of releases.
	if (need.has('albumArtist') && track.artist?.name) patch.albumArtist = track.artist.name;
	if (need.has('year') && track.album?.release_date) {
		const y = Number(track.album.release_date.slice(0, 4));
		if (Number.isFinite(y) && y > 1000) patch.year = y;
	}
	if (need.has('isrc') && track.isrc) patch.isrc = track.isrc;
	if (need.has('coverUrl') && track.album?.cover_xl) patch.coverUrl = track.album.cover_xl;
	if (need.has('genre')) {
		const genre = await albumGenres(track.album?.id);
		if (genre) patch.genre = genre;
	}
	// No track/disc numbers in the search payload — `needs:trackNumber` stays
	// unanswered rather than being filled with a guess.
	return Object.keys(patch).length > 0 ? patch : null;
}
