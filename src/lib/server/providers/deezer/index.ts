import { callGateway, getDeezerSession } from './gateway';
import { resolveStream } from './media';
import { isDeezerShortLink, parseDeezerTrackUrl } from './parse';
import { ProviderError, type Provider, type TrackMeta } from '$lib/server/providers/types';
import { logger } from '$lib/server/logger';

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
		// Phase 2 wires this into the UI; the capability ships with the trait.
		const body = await callGateway('search.music', { query, filter: 'TRACKS' });
		const results = body.results as
			{ TRACKS?: { data?: Array<Record<string, unknown>> } } | undefined;
		const rows = results?.TRACKS?.data ?? [];
		return rows.slice(0, 25).map((r) => gatewayRowToMeta(r));
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
		coverUrl: null,
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
