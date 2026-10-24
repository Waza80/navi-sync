import { callGateway, getDeezerSession } from './gateway';
import { resolveStream } from './media';
import { isDeezerShortLink, parseDeezerUrl } from './parse';
import { ProviderError, type Provider, type TrackMeta } from '$lib/server/providers/types';
import { logger } from '$lib/server/logger';

async function resolveShortLink(input: string): Promise<string | null> {
	for (const method of ['HEAD', 'GET'] as const) {
		try {
			const res = await fetch(input.trim(), {
				method,
				redirect: 'follow',
				signal: AbortSignal.timeout(10_000),
			});
			const final = res.url;
			if (method === 'GET') await res.arrayBuffer();
			if (final && !/link\.deezer\.com/.test(final)) return final.split('?')[0];
		} catch {
			continue;
		}
	}
	return null;
}

const log = logger;

/**
 * Deezer provider — Phase 1 reference implementation of the Provider contract.
 * Metadata: gateway song.getData (auth) enriched by the public api.deezer.com
 * track endpoint (ISRC / cover / genre / year) on a best-effort basis.
 */

interface GatewayTrackData {
	SNG_ID?: string | number;
	SNG_TITLE?: string;
	ART_NAME?: string;
	ALB_TITLE?: string;
	ALB_PICTURE?: string;
	ARTISTS?: Array<{ ART_NAME?: string }>;
	TRACK_NUMBER?: string | number;
	DISK_NUMBER?: string | number;
	DURATION?: string | number;
	ISRC?: string;
	TRACK_TOKEN?: string;
	ART_ID?: string | number;
	ALB_ID?: string | number;
}

interface PublicTrackData {
	title?: string;
	title_version?: string;
	isrc?: string;
	duration?: number;
	track_position?: number;
	disk_number?: number;
	release_date?: string;
	preview?: string;
	artist?: { name?: string };
	album?: { title?: string; cover_xl?: string; tracklist?: string };
	contributors?: Array<{ name?: string }>;
	genres?: { data?: Array<{ name?: string }> };
	error?: unknown;
}

function toInt(v: string | number | undefined | null): number | null {
	if (v === undefined || v === null) return null;
	const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
	return Number.isFinite(n) ? n : null;
}

export const deezerProvider: Provider = {
	id: 'deezer',
	displayName: 'Deezer',

	matches(url) {
		return parseDeezerUrl(url) !== null || isDeezerShortLink(url);
	},

	async parseRef(input) {
		const direct = parseDeezerUrl(input);
		if (direct) {
			// Only a TRACK is downloadable as audio. An album or artist link is a
			// fan-out request, not a track ref, so parseRef must decline it — but the
			// id and kind are still carried on the ref so a caller can route it.
			return {
				provider: 'deezer',
				id: direct.id,
				kind: direct.kind,
				sourceUrl: `https://www.deezer.com/${direct.kind}/${direct.id}`,
			};
		}
		if (isDeezerShortLink(input)) {
			// Resolve short link by following redirects (HEAD, then GET fallback).
			for (const method of ['HEAD', 'GET'] as const) {
				try {
					const res = await fetch(input.trim(), {
						method,
						redirect: 'follow',
						signal: AbortSignal.timeout(10_000),
					});
					const final = res.url;
					if (method === 'GET') await res.arrayBuffer();
					const parsed = parseDeezerUrl(final);
					if (parsed) {
						// The redirect target decides the kind: a shared ARTIST link
						// lands on /artist/{id}, not /track/{id}, which is why these
						// used to come back as unparseable.
						log.debug('resolved deezer short link', {
							id: parsed.id,
							kind: parsed.kind,
						});
						return {
							provider: 'deezer',
							id: parsed.id,
							kind: parsed.kind,
							sourceUrl: final.split('?')[0],
						};
					}
				} catch {
					continue;
				}
			}
		}
		return null;
	},

	async search(query) {
		// gw-light search.music requires BOTH filter and output; rows come back
		// directly under results.data (verified live 2026-10).
		const body = await callGateway('search.music', {
			query,
			filter: 'TRACKS',
			output: 'TRACK',
		});
		const results = body.results as { data?: Array<Record<string, unknown>> } | undefined;
		const rows = results?.data ?? [];
		return rows.slice(0, 25).map((r) => gatewayRowToMeta(r));
	},

	async resolveLink(
		input: string,
	): Promise<{ kind: 'track' | 'album' | 'artist' | 'playlist'; id: string } | null> {
		// Canonicalizes any deezer link (incl. link.deezer.com short links)
		// into {kind, id}: track, album, artist or playlist.
		//
		// This used to answer `{ kind: 'track' }` for EVERY direct link, so an
		// album or artist URL took the single-track path: the worker fetched
		// song.getData with an album id and the request failed with a confusing
		// "No song data" instead of fanning the collection out. The kind is the
		// whole point of this call — discarding it made paste behaviour depend on
		// which route happened to parse the link first.
		const direct = parseDeezerUrl(input);
		if (direct) return { kind: direct.kind, id: direct.id };

		const target = isDeezerShortLink(input) ? await resolveShortLink(input) : input;
		if (!target) return null;
		try {
			const url = new URL(target);
			if (!/(^|\.)deezer\.com$/.test(url.hostname)) return null;
			const m = /\/(track|album|artist|playlist)\/(\d+)/.exec(url.pathname);
			if (!m) return null;
			return { kind: m[1] as 'track' | 'album' | 'artist' | 'playlist', id: m[2] };
		} catch {
			return null;
		}
	},

	async playlistTrackIds(playlistId: string, max = 2000): Promise<string[]> {
		// Track list lives at results.SONGS.data of deezer.pagePlaylist
		// (reference: DeezerPlaylist.loadTracks; verified live 2026-10).
		//
		// `nb` is capped at 300 server-side, so a single call silently truncated
		// every playlist to its first 300 tracks — a 490-track playlist was
		// downloaded as 300 and the rest were never seen. The gateway accepts
		// `start`, so page until the playlist is exhausted or the caller's cap is
		// reached. IDs are deduped: a playlist may contain the same track twice,
		// and two jobs for one SNG_ID would race to file the same audio.
		const wanted = Math.max(1, Math.min(5000, max));
		const PAGE = 300;
		const out: string[] = [];
		const seen = new Set<string>();
		let start = 0;
		while (out.length < wanted) {
			const nb = Math.min(PAGE, wanted - out.length);
			const body = await callGateway('deezer.pagePlaylist', {
				playlist_id: playlistId,
				lang: 'en',
				nb,
				tags: false,
				start,
			});
			const results = body.results as {
				SONGS?: { data?: Array<{ SNG_ID?: string | number }> };
			};
			const rows = results?.SONGS?.data ?? [];
			if (rows.length === 0) break;
			for (const r of rows) {
				const id = String(r.SNG_ID ?? '');
				if (/^\d+$/.test(id) && !seen.has(id)) {
					seen.add(id);
					out.push(id);
				}
			}
			// A short page means the playlist ended; a full page means ask again.
			if (rows.length < nb) break;
			start += rows.length;
		}
		return out.slice(0, wanted);
	},

	async metadata(ref) {
		const body = await callGateway('song.getData', { sng_id: ref.id });
		const results = body.results as GatewayTrackData | undefined;
		if (!results || !results.SNG_TITLE) {
			throw new ProviderError(`Deezer track ${ref.id} not found`, 'NOT_FOUND');
		}
		const meta: TrackMeta = {
			provider: 'deezer',
			providerTrackId: String(results.SNG_ID ?? ref.id),
			title: results.SNG_TITLE,
			artist: results.ART_NAME ?? 'Unknown Artist',
			album: results.ALB_TITLE ?? null,
			albumArtist: results.ART_NAME ?? null,
			isrc: results.ISRC ?? null,
			trackNumber: toInt(results.TRACK_NUMBER),
			discNumber: toInt(results.DISK_NUMBER),
			durationSec: toInt(results.DURATION),
			year: null,
			genre: null,
			coverUrl: null,
			sourceUrl: ref.sourceUrl ?? `https://www.deezer.com/track/${ref.id}`,
			streamToken: results.TRACK_TOKEN ?? null,
		};
		await enrichFromPublicApi(meta, ref.id);
		return meta;
	},

	async searchAlbums(query) {
		const body = await callGateway('search.music', {
			query,
			filter: 'ALBUM',
			output: 'ALBUM',
		});
		const results = body.results as { data?: Array<Record<string, unknown>> } | undefined;
		const rows = results?.data ?? [];
		return rows.slice(0, 15).map((raw) => {
			const album = raw as {
				ALB_ID?: string | number;
				ALB_TITLE?: string;
				ALB_PICTURE?: string;
				ART_NAME?: string;
				ARTISTS?: Array<{ ART_NAME?: string }>;
				YEAR?: string | number;
			};
			const artist = album.ART_NAME ?? album.ARTISTS?.[0]?.ART_NAME ?? 'Unknown Artist';
			const pic = String(album.ALB_PICTURE ?? '');
			return {
				provider: 'deezer',
				albumId: String(album.ALB_ID ?? ''),
				title: String(album.ALB_TITLE ?? ''),
				artist: String(artist),
				year: album.YEAR != null ? Number(album.YEAR) : null,
				coverUrl: pic
					? `https://e-cdns-images.dzcdn.net/images/cover/${pic}/500x500-000000-80-0-0.jpg`
					: null,
			};
		});
	},

	async albumTrackIds(albumId) {
		// Track list lives at results.SONGS.data of deezer.pageAlbum
		// (reference: DeezerAlbum.album → loadTracks; verified live 2026-10).
		const body = await callGateway('deezer.pageAlbum', {
			alb_id: albumId,
			header: true,
			lang: 'en',
		});
		const results = body.results as { SONGS?: { data?: Array<{ SNG_ID?: string | number }> } };
		const rows = results?.SONGS?.data ?? [];
		// Dedupe: a duplicated id in the payload used to enqueue two jobs for one
		// track, and whichever job lost the file race became a second row pointing
		// at the winner's file — the "one-track album downloads twice" report.
		const seen = new Set<string>();
		for (const r of rows) {
			const id = String(r.SNG_ID ?? '');
			if (/^\d+$/.test(id)) seen.add(id);
		}
		return [...seen];
	},

	/**
	 * Artist search via the public API — no gateway auth, so it works even when
	 * the Deezer session is absent. This is the entry point for artist fan-out.
	 */
	async searchArtists(
		query: string,
	): Promise<Array<{ artistId: string; name: string; trackCount: number | null }>> {
		const res = await fetch(
			`https://api.deezer.com/search/artist?q=${encodeURIComponent(query)}&limit=10`,
			{ signal: AbortSignal.timeout(10_000) },
		).catch(() => null);
		if (!res?.ok) return [];
		const body = (await res.json()) as {
			data?: Array<{ id?: number; name?: string; nb_album?: number }>;
		};
		return (body.data ?? [])
			.filter((a) => typeof a.id === 'number')
			.map((a) => ({
				artistId: String(a.id),
				name: a.name ?? '',
				trackCount: typeof a.nb_album === 'number' ? a.nb_album : null,
			}));
	},

	/**
	 * Album ids for an artist. The public `/artist/{id}/albums` endpoint works
	 * without auth and is enough here, so fan-out does not depend on the
	 * gateway session being alive. Ordered by the API's own ranking.
	 */
	async artistAlbumIds(artistId: string, max = 100): Promise<string[]> {
		// Paginated with `index`. A single `limit=100` call silently dropped every
		// release after the first hundred — and for an artist whose catalogue is
		// ranked across many pages, which albums appeared depended on nothing the
		// user could see. IDs are deduped so an album listed twice (re-release
		// grouped under the same id) is only fetched once.
		const wanted = Math.max(1, Math.min(500, max));
		const PAGE = 100;
		const out: string[] = [];
		const seen = new Set<string>();
		let index = 0;
		while (out.length < wanted) {
			const limit = Math.min(PAGE, wanted - out.length);
			const res = await fetch(
				`https://api.deezer.com/artist/${encodeURIComponent(artistId)}/albums?limit=${limit}&index=${index}`,
				{ signal: AbortSignal.timeout(15_000) },
			).catch(() => null);
			// First page failing means "no albums"; a later page failing keeps what
			// we have rather than discarding a partial catalogue.
			if (!res?.ok) break;
			const body = (await res.json()) as { data?: Array<{ id?: number }> };
			const rows = body.data ?? [];
			if (rows.length === 0) break;
			for (const a of rows) {
				if (typeof a.id === 'number') seen.add(String(a.id));
			}
			if (rows.length < limit) break;
			index += rows.length;
		}
		return [...seen].slice(0, wanted);
	},

	async findByIsrc(isrc) {
		// Public API — exact ISRC lookup, no gateway auth needed.
		const res = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as {
			id?: number | string;
			title?: string;
			artist?: { name?: string };
			album?: { title?: string; cover_xl?: string };
			duration?: number;
			release_date?: string;
			error?: unknown;
		};
		if (!data.id || data.error) return null;
		return {
			provider: 'deezer',
			providerTrackId: String(data.id),
			title: data.title ?? 'Unknown Title',
			artist: data.artist?.name ?? 'Unknown Artist',
			album: data.album?.title ?? null,
			albumArtist: data.artist?.name ?? null,
			isrc,
			trackNumber: null,
			discNumber: null,
			durationSec: data.duration ?? null,
			year: data.release_date
				? Number.parseInt(data.release_date.slice(0, 4), 10) || null
				: null,
			genre: null,
			coverUrl: data.album?.cover_xl ?? null,
			sourceUrl: `https://www.deezer.com/track/${data.id}`,
			streamToken: null,
		};
	},

	async resolve(meta, prefs) {
		if (!meta.streamToken) {
			throw new ProviderError(
				'Track has no stream token (sign-in expired or track restricted)',
				'NO_STREAM',
			);
		}
		await getDeezerSession(); // fail fast with a clear auth error if session is broken
		return resolveStream(meta.streamToken, meta.providerTrackId, prefs);
	},
};

function gatewayRowToMeta(r: Record<string, unknown>): TrackMeta {
	const g = r as GatewayTrackData;
	return {
		provider: 'deezer',
		providerTrackId: String(g.SNG_ID ?? ''),
		title: g.SNG_TITLE ?? '',
		artist: g.ART_NAME ?? 'Unknown Artist',
		album: g.ALB_TITLE ?? null,
		albumArtist: g.ART_NAME ?? null,
		isrc: g.ISRC ?? null,
		trackNumber: toInt(g.TRACK_NUMBER),
		discNumber: toInt(g.DISK_NUMBER),
		durationSec: toInt(g.DURATION),
		year: null,
		genre: null,
		coverUrl:
			g.ALB_PICTURE != null && String(g.ALB_PICTURE).length > 0
				? `https://e-cdns-images.dzcdn.net/images/cover/${String(g.ALB_PICTURE)}/500x500-000000-80-0-0.jpg`
				: null,
		sourceUrl: `https://www.deezer.com/track/${g.SNG_ID ?? ''}`,
		streamToken: g.TRACK_TOKEN ?? null,
	};
}

async function enrichFromPublicApi(meta: TrackMeta, id: string): Promise<void> {
	try {
		const res = await fetch(`https://api.deezer.com/track/${id}`, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return;
		const data = (await res.json()) as PublicTrackData;
		if (data.error) return;
		if (data.isrc) meta.isrc = data.isrc;
		if (data.duration) meta.durationSec = data.duration;
		if (data.track_position) meta.trackNumber = data.track_position;
		if (data.disk_number) meta.discNumber = data.disk_number;
		if (data.release_date) {
			const year = Number.parseInt(data.release_date.slice(0, 4), 10);
			if (Number.isFinite(year)) meta.year = year;
		}
		if (data.artist?.name) meta.artist = data.artist.name;
		if (data.album?.title) meta.album = data.album.title;
		if (data.album?.cover_xl) meta.coverUrl = data.album.cover_xl;
		const genre = data.genres?.data?.[0]?.name;
		if (genre) meta.genre = genre;
	} catch (err) {
		// Enrichment is optional — core metadata already present.
		log.debug('deezer public-api enrichment skipped', { error: String(err) });
	}
}
