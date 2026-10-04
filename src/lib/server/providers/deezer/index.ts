import { callGateway, getDeezerSession } from './gateway';
import { resolveStream } from './media';
import { isDeezerShortLink, parseDeezerTrackUrl } from './parse';
import { ProviderError, type Provider, type TrackMeta } from '$lib/server/providers/types';
import { logger } from '$lib/server/logger';

async function resolveShortLink(input: string): Promise<string | null> {
	for (const method of ['HEAD', 'GET'] as const) {
		try {
			const res = await fetch(input.trim(), {
				method,
				redirect: 'follow',
				signal: AbortSignal.timeout(10_000)
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
		return parseDeezerTrackUrl(url) !== null || isDeezerShortLink(url);
	},

	async parseRef(input) {
		const direct = parseDeezerTrackUrl(input);
		if (direct) {
			return {
				provider: 'deezer',
				id: direct.id,
				sourceUrl: `https://www.deezer.com/track/${direct.id}`,
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
					const parsed = parseDeezerTrackUrl(final);
					if (parsed) {
						log.debug('resolved deezer short link', { id: parsed.id });
						return {
							provider: 'deezer',
							id: parsed.id,
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
		input: string
	): Promise<{ kind: 'track' | 'album' | 'playlist'; id: string } | null> {
		// Canonicalizes any deezer link (incl. link.deezer.com short links)
		// into {kind, id}: track, album or playlist.
		const direct = parseDeezerTrackUrl(input);
		if (direct) return { kind: 'track', id: direct.id };

		const target = isDeezerShortLink(input) ? await resolveShortLink(input) : input;
		if (!target) return null;
		try {
			const url = new URL(target);
			if (!/(^|\.)deezer\.com$/.test(url.hostname)) return null;
			const m = /\/(track|album|playlist)\/(\d+)/.exec(url.pathname);
			if (!m) return null;
			return { kind: m[1] as 'track' | 'album' | 'playlist', id: m[2] };
		} catch {
			return null;
		}
	},

	async playlistTrackIds(playlistId: string, max = 300): Promise<string[]> {
		// Track list lives at results.SONGS.data of deezer.pagePlaylist
		// (reference: DeezerPlaylist.loadTracks; verified live 2026-10).
		const body = await callGateway('deezer.pagePlaylist', {
			playlist_id: playlistId,
			lang: 'en',
			nb: max,
			tags: false,
			start: 0
		});
		const results = body.results as { SONGS?: { data?: Array<{ SNG_ID?: string | number }> } };
		const rows = results?.SONGS?.data ?? [];
		return rows.map((r) => String(r.SNG_ID ?? '')).filter((id) => /^\d+$/.test(id));
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
			lang: 'en'
		});
		const results = body.results as { SONGS?: { data?: Array<{ SNG_ID?: string | number }> } };
		const rows = results?.SONGS?.data ?? [];
		return rows.map((r) => String(r.SNG_ID ?? '')).filter((id) => /^\d+$/.test(id));
	},

	async findByIsrc(isrc) {
		// Public API — exact ISRC lookup, no gateway auth needed.
		const res = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`, {
			signal: AbortSignal.timeout(10_000)
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
			year: data.release_date ? Number.parseInt(data.release_date.slice(0, 4), 10) || null : null,
			genre: null,
			coverUrl: data.album?.cover_xl ?? null,
			sourceUrl: `https://www.deezer.com/track/${data.id}`,
			streamToken: null
		};
	},

	async resolve(meta, prefs) {
		if (!meta.streamToken) {
			throw new ProviderError(
				'Track has no stream token (expired or restricted)',
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
