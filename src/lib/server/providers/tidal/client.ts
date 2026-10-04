import {
	ProviderError,
	type QualityPreferences,
	type StreamResolution,
} from '$lib/server/providers/types';
import { parseDashManifest, parseStreamInfo, type DashManifest } from './mp4';

/**
 * Tidal client — a self-hosted `hifi-api` instance (github.com/binimum/hifi-api).
 *
 * The instance owns the Tidal account: navi-sync never sees a refresh token, a
 * client id, or any other credential. We configure exactly one thing — the
 * instance URL — which is why this provider needs no secrets.
 *
 * Verified live against a v2.10 instance (2026-10):
 *   GET {base}/search/?s=<q>            → {data:{items:[…]}}   text search
 *   GET {base}/search/?i=<ISRC>         → 0 items               ISRC search is dead
 *   GET {base}/info/?id=<trackId>       → track + album + artist
 *   GET {base}/album/?id=<albumId>      → album + its tracks    (album fan-out)
 *   GET {base}/track/?id=<id>&quality=Q → base64 DASH MPD       playback manifest
 *
 * PERFORMANCE — measured on a real full-length track:
 *   41.8 MiB in 7.8s  = 5.4 MiB/s   (CD lossless, 93 segments)
 *   256 MiB in 37.2s  = 6.9 MiB/s   (24/192 hi-res, 88 segments)
 * That is ~250x the throughput of the Cloudflare-capped instance this provider
 * replaces, and it comes from a normal CDN rather than a throttled origin.
 *
 * REQUEST SHAPE — Tidal no longer offers a single-file lossless URL: the
 * README's BTS/EMBEDDED manifest is gone and everything is fragmented MP4, so
 * ~90 requests per track is the floor. Those are independent CDN objects, not
 * throttled chunks of one stream, which is why plain parallel GETs work.
 */

export interface TidalConfig {
	instanceUrl: string;
	quality?: 'HI_RES_LOSSLESS' | 'LOSSLESS' | 'LOW';
}

export interface TidalTrack {
	id: string;
	title: string;
	artist: string;
	album: string | null;
	albumId: string | null;
	albumArtist: string | null;
	durationSec: number | null;
	isrc: string | null;
	artworkUrl: string | null;
	trackNumber: number | null;
	discNumber: number | null;
	year: number | null;
	sourceUrl: string | null;
}

/** A track as it must be fetched: which segments, and what quality. */
export interface TidalStreamPlan {
	manifest: DashManifest;
	bitDepth: number | null;
	sampleRateHz: number | null;
	quality: string | null;
}

/** Raw track shape returned by the instance (v2 openapi passthrough). */
interface RawAlbum {
	id?: number | string;
	title?: string;
	cover?: string;
	releaseDate?: string | null;
	artist?: { name?: string };
	[key: string]: unknown;
}

interface RawTrack {
	id?: number | string;
	title?: string;
	version?: string | null;
	isrc?: string;
	duration?: number;
	trackNumber?: number;
	volumeNumber?: number;
	releaseDate?: string | null;
	artist?: { name?: string };
	artists?: Array<{ name?: string }>;
	album?: RawAlbum;
	mediaMetadata?: { tags?: string[]; hires?: boolean };
	[key: string]: unknown;
}

interface Envelope<T> {
	version?: string;
	data?: T;
	detail?: string;
}

/** Unwrap the instance's `{version, data}` envelope, tolerating a bare body. */
function unbox<T>(body: Envelope<T> | T): T {
	if (body && typeof body === 'object' && 'data' in body) {
		const inner = (body as { data?: T }).data;
		if (inner !== undefined) return inner;
	}
	return body as T;
}

export class TidalClient {
	#config: TidalConfig;

	constructor(config: TidalConfig) {
		this.#config = config;
	}

	get base(): string {
		return this.#config.instanceUrl.replace(/\/+$/, '');
	}

	#accept = { Accept: 'application/json', 'User-Agent': 'NaviSync/1.0' };

	async #get<T>(path: string, timeoutMs = 30_000): Promise<T> {
		let res: Response;
		try {
			res = await fetch(`${this.base}${path}`, {
				headers: this.#accept,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			throw new ProviderError(
				`Tidal instance unreachable: ${err instanceof Error ? err.message : String(err)}`,
				'PROVIDER_UNAVAILABLE',
			);
		}
		const body = (await res.json().catch(() => null)) as Envelope<T> | null;
		if (!res.ok) {
			// 401 means the instance has no working Tidal credentials — that is
			// the single most common misconfiguration, so name it explicitly.
			const detail =
				body?.detail ??
				`Tidal instance returned HTTP ${res.status} for ${path.split('?')[0]}`;
			throw new ProviderError(
				res.status === 401
					? `${detail} — the instance's Tidal account is not authorized`
					: detail,
				res.status === 404 ? 'NOT_FOUND' : 'PROVIDER_UNAVAILABLE',
			);
		}
		if (body == null) {
			throw new ProviderError(
				'Tidal instance returned a non-JSON body',
				'PROVIDER_UNAVAILABLE',
			);
		}
		return unbox(body);
	}

	/** Instance reachability + catalog probe. */
	async ping(): Promise<{ ok: boolean; detail?: string }> {
		try {
			const tracks = await this.search('the');
			return { ok: true, detail: `search returned ${tracks.length} results` };
		} catch (err) {
			return { ok: false, detail: err instanceof Error ? err.message : String(err) };
		}
	}

	/** Text search. The instance wraps results in `{data:{items:[…]}}`. */
	async search(query: string, limit = 25): Promise<TidalTrack[]> {
		const raw = await this.#get<{ items?: RawTrack[] }>(
			`/search/?s=${encodeURIComponent(query)}&limit=${limit}`,
		);
		return (raw.items ?? []).filter((t) => t?.id != null).map((t) => toTidalTrack(t));
	}

	/**
	 * Exact ISRC lookup.
	 *
	 * The instance exposes `/search/?i=<ISRC>`, but Tidal's v1 `?isrc=` filter now
	 * returns an empty list for every ISRC and `filter[isrc]` 400s with "ISRC is
	 * missing" (verified 2026-10). So we still ask — it costs one request and
	 * will start working the day Tidal repairs the index — but we do NOT trust
	 * it alone: we fall back to a text search and accept a hit only when its
	 * ISRC matches exactly. Guessing here would file the wrong album.
	 *
	 * ISRCs are NOT unique in Tidal's catalogue: the same recording appears on
	 * its original album and on compilations (verified — USQX91300108 resolves
	 * to both "Random Access Memories" and "Decade of Summer: The 10s"). So when
	 * a reference is supplied we keep the candidate from the requested album.
	 */
	async findByIsrc(
		isrc: string,
		artist?: string,
		title?: string,
		ref?: { albumId?: string | null; album?: string | null },
	): Promise<TidalTrack | null> {
		const wanted = isrc.trim().toUpperCase();
		if (!wanted) return null;

		const exact = (t: { isrc?: string | null }): boolean =>
			(t.isrc ?? '').toUpperCase() === wanted;

		/** Prefer the requested album so a compilation cannot hijack the folder. */
		const pick = <
			T extends { isrc?: string | null; albumId?: string | null; album?: string | null },
		>(
			hits: T[],
		): T | null => {
			const matches = hits.filter(exact);
			if (matches.length <= 1) return matches[0] ?? null;
			if (ref?.albumId) {
				return matches.find((t) => t.albumId === ref.albumId) ?? null;
			}
			if (ref?.album) {
				const byName = matches.find(
					(t) => (t.album ?? '').toLowerCase() === ref.album?.toLowerCase(),
				);
				if (byName) return byName;
			}
			// Ambiguous with no reference to disambiguate: refuse rather than
			// pick one and risk filing under the wrong album.
			return null;
		};

		try {
			const direct = await this.#get<{ items?: RawTrack[] }>(
				`/search/?i=${encodeURIComponent(wanted)}&limit=10`,
			);
			const hit = pick(
				(direct.items ?? []).filter((t) => t?.id != null).map((t) => toTidalTrack(t)),
			);
			if (hit) return hit;
		} catch {
			// Fall through to the text-search path.
		}
		const query = [artist, title].filter(Boolean).join(' ').trim();
		if (!query) return null;
		try {
			return pick(await this.search(query, 50));
		} catch {
			return null;
		}
	}

	/** Full metadata for one track, including its album. */
	async track(trackId: string): Promise<TidalTrack> {
		const raw = await this.#get<RawTrack>(`/info/?id=${encodeURIComponent(trackId)}`);
		return toTidalTrack(raw, trackId);
	}

	/**
	 * Every track on an album — enables album fan-out.
	 *
	 * The instance returns `items: [{item: <track>}]` (a v2 relationship
	 * envelope), so each entry is unwrapped before mapping.
	 */
	async albumTracks(albumId: string): Promise<TidalTrack[]> {
		const raw = await this.#get<RawAlbum & { items?: Array<{ item?: RawTrack }> }>(
			`/album/?id=${encodeURIComponent(albumId)}`,
		);
		// Album context is absent on each item, so inherit the fields fan-out
		// needs (cover, release date, title) from the album itself. Only the
		// album's own fields are taken — `items` is a track list, not metadata.
		const inherited: RawAlbum = {
			id: raw.id,
			title: raw.title,
			cover: raw.cover,
			releaseDate: raw.releaseDate,
			artist: raw.artist,
		};
		return (raw.items ?? [])
			.map((entry) => entry?.item)
			.filter((t): t is RawTrack => t?.id != null)
			.map((t) => toTidalTrack({ ...t, album: t.album ?? inherited }));
	}

	/**
	 * Resolve a track to a concrete download plan.
	 *
	 * Requests `HI_RES_LOSSLESS` first and falls back down only if the track has
	 * no such master — Tidal answers with the best it actually has, so the
	 * reported bit depth is the truth for that release (16/44.1, 24/96, 24/192…).
	 */
	async streamPlan(trackId: string, prefs?: QualityPreferences): Promise<TidalStreamPlan> {
		const preferred: Array<TidalConfig['quality']> =
			prefs?.preferLossless === false
				? ['LOW', 'LOSSLESS']
				: [this.#config.quality ?? 'HI_RES_LOSSLESS', 'LOSSLESS', 'LOW'];

		const tried: string[] = [];
		for (const quality of preferred) {
			if (!quality) continue;
			tried.push(quality);
			try {
				const body = await this.#get<{
					manifest?: string;
					audioQuality?: string;
					bitDepth?: number;
					sampleRate?: number;
				}>(`/track/?id=${encodeURIComponent(trackId)}&quality=${quality}`, 45_000);
				if (!body?.manifest) continue;
				const manifest = parseDashManifest(
					Buffer.from(body.manifest, 'base64').toString('utf8'),
				);
				return {
					manifest,
					bitDepth: typeof body.bitDepth === 'number' ? body.bitDepth : null,
					sampleRateHz: typeof body.sampleRate === 'number' ? body.sampleRate : null,
					quality: body.audioQuality ?? quality,
				};
			} catch (err) {
				// 404 = this release has no master at that tier; try the next.
				if (err instanceof ProviderError && err.code === 'NOT_FOUND') continue;
				if (tried.length === preferred.length) throw err;
			}
		}
		throw new ProviderError(
			`No playable master for track ${trackId} (tried ${tried.join(', ')})`,
			'NO_STREAM',
		);
	}

	/**
	 * StreamResolution for the pipeline.
	 *
	 * The instance hands back a MANIFEST, not audio, so `url` carries the
	 * manifest endpoint for traceability while `segments` carries the actual
	 * fetch plan. `claimedBitDepth` is the depth Tidal reports for this release
	 * — measured, not invented, unlike the Cloudflare instance which had no
	 * quality parameter at all.
	 */
	async resolve(
		trackId: string,
		prefs: QualityPreferences,
	): Promise<StreamResolution & { segments: NonNullable<StreamResolution['segments']> }> {
		const plan = await this.streamPlan(trackId, prefs);
		return {
			url: `${this.base}/track/?id=${encodeURIComponent(trackId)}`,
			format: 'flac',
			ext: 'flac',
			claimedBitrateKbps: null,
			claimedLossless: plan.quality !== 'LOW',
			claimedBitDepth: plan.bitDepth,
			cipher: 'NONE',
			decryptTrackId: null,
			segments: {
				initUrl: plan.manifest.initUrl,
				mediaUrls: Array.from({ length: plan.manifest.segmentCount }, (_, i) =>
					plan.manifest.segmentUrl(i + 1),
				),
			},
		};
	}
}

/* ── mapping ─────────────────────────────────────────────────────────────── */

/** Album cover URL for a Tidal cover id. Returns null when unknown. */
export function tidalCoverUrl(cover: string | undefined | null): string | null {
	if (!cover) return null;
	// Already an absolute URL (some responses inline one).
	if (/^https?:\/\//i.test(cover)) return cover;
	// Tidal cover ids are UUIDs whose dashes address CDN path segments, so
	// `b66a5c40-c34d-…` must become `b66a5c40/c34d/…` — leaving the dashes in
	// returns 403 (verified).
	const slug = cover.replace(/-/g, '/');
	return `https://resources.tidal.com/images/${slug}/1280x1280.jpg`;
}

/** First four-digit year of an ISO date, or null. */
function yearOf(date: string | null | undefined): number | null {
	if (!date) return null;
	const m = /^\s*(\d{4})/.exec(date);
	return m?.[1] ? Number(m[1]) : null;
}

export function toTidalTrack(raw: RawTrack, idFallback = ''): TidalTrack {
	const id = String(raw.id ?? idFallback ?? '');
	const artists = Array.isArray(raw.artists) ? raw.artists : [];
	// Album fan-out items arrive with no artist of their own, so the album's
	// artist is the last resort before giving up on a real name.
	const artist =
		raw.artist?.name ??
		artists.find((a) => a?.name)?.name ??
		raw.album?.artist?.name ??
		'Unknown Artist';
	const albumArtist = raw.album?.artist?.name ?? artists[0]?.name ?? artist;
	// Tidal's `title` excludes the version/edition suffix; `version` holds it.
	// NaviSync files by title, so keep them together for a readable filename.
	const title = raw.version ? `${raw.title ?? 'Unknown Title'} (${raw.version})` : raw.title;
	return {
		id,
		title: title ?? 'Unknown Title',
		artist,
		album: raw.album?.title ?? null,
		albumId: raw.album?.id != null ? String(raw.album.id) : null,
		albumArtist,
		durationSec: typeof raw.duration === 'number' ? Math.round(raw.duration) : null,
		isrc: raw.isrc ?? null,
		artworkUrl: tidalCoverUrl(raw.album?.cover),
		trackNumber: typeof raw.trackNumber === 'number' ? raw.trackNumber : null,
		discNumber: typeof raw.volumeNumber === 'number' ? raw.volumeNumber : null,
		// Track-level releaseDate is usually null; the album carries it.
		year: yearOf(raw.releaseDate) ?? yearOf(raw.album?.releaseDate),
		sourceUrl: id ? `https://tidal.com/track/${id}` : null,
	};
}

export { parseStreamInfo };
