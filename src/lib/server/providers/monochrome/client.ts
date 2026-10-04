import {
	getManifestFormatsForQuality,
	generateDashSegmentUrls,
	inferDashExtension,
	parseDashManifest,
	type DashManifest,
} from './dash';
import {
	ProviderError,
	type StreamResolution,
	type QualityPreferences,
	type TrackMeta,
} from '$lib/server/providers/types';
import { logger } from '$lib/server/logger';

const log = logger;

/**
 * Monochrome client — talks to a self-hosted Monochrome instance
 * (TIDAL proxy; reference: atvalerie/monodownload + the official SPA).
 *
 *   GET {base}/search/?s=<query>                       → catalog search
 *   GET {base}/info/?id=<trackId>                      → track metadata
 *   GET {base}/trackManifests/?id=…&formats=…          → DASH manifest URI
 *   GET manifest → parse MPD → fetch init+segments     → concatenated audio
 *
 * Auth: instances built on the official SPA use Better Auth — we sign in with
 * email/password (`POST /api/auth/sign-in/email`) and reuse the session
 * cookie. Anonymous access works on instances that allow it.
 */

export interface MonochromeConfig {
	instanceUrl: string;
	/** Pasted browser session cookie (Cloudflare-proof). Preferred. */
	sessionCookie?: string;
	username?: string;
	password?: string;
	quality?: 'HI_RES_LOSSLESS' | 'LOSSLESS' | 'LOW';
}

export interface MonochromeTrack {
	id: string | number;
	title?: string;
	name?: string;
	artists?: Array<{ name?: string } | string>;
	artist?: { name?: string } | string;
	album?: { title?: string; name?: string } | string;
	trackNumber?: number | string;
	duration?: number | string;
	releaseDate?: string;
	isrc?: string;
	audioQuality?: string;
}

export class MonochromeClient {
	#config: MonochromeConfig;
	#cookie: string | null = null;

	constructor(config: MonochromeConfig) {
		this.#config = config;
	}

	get base(): string {
		return this.#config.instanceUrl.replace(/\/+$/, '');
	}

	/** Better Auth sign-in against the instance; caches the session cookie. */
	async ensureAuth(): Promise<void> {
		if (this.#cookie) return;
		const { sessionCookie, username, password } = this.#config;
		if (sessionCookie) {
			// Raw cookie paste (name=value or full value) — Cloudflare-proof.
			this.#cookie = sessionCookie.includes('=')
				? sessionCookie
				: `better-auth.session_token=${sessionCookie}`;
			return;
		}
		if (!username || !password) return; // try anonymous
		const res = await fetch(`${this.base}/api/auth/sign-in/email`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json',
				Origin: this.base,
				'User-Agent': 'NaviSync/0.2',
			},
			body: JSON.stringify({ email: username, password }),
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) {
			throw new ProviderError(
				`Monochrome sign-in failed (HTTP ${res.status}) — check username/password`,
				'AUTH_FAILED',
			);
		}
		const cookies = res.headers.getSetCookie();
		this.#cookie = cookies.map((c) => c.split(';')[0]).join('; ') || null;
		log.info('monochrome signed in', { instance: this.base });
	}

	async #getJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const attempt = async (): Promise<Response> =>
			fetch(url, {
				headers: {
					Accept: 'application/json',
					...(this.#cookie ? { Cookie: this.#cookie } : {}),
					Origin: this.base,
				},
				signal: signal ?? AbortSignal.timeout(20_000),
			});
		let res = await attempt();
		// Instances behind the SPA catch-all return HTML when unauthenticated.
		const ctype = res.headers.get('content-type') ?? '';
		if (ctype.includes('text/html') && this.#config.username) {
			this.#cookie = null;
			await this.ensureAuth();
			res = await attempt();
		}
		if (res.status === 401)
			throw new ProviderError('Monochrome instance rejected credentials', 'AUTH_FAILED');
		if (!res.ok)
			throw new ProviderError(
				`Monochrome request failed: HTTP ${res.status}`,
				'PROVIDER_UNAVAILABLE',
			);
		if ((res.headers.get('content-type') ?? '').includes('text/html')) {
			throw new ProviderError(
				'Monochrome returned HTML — login required or endpoint unavailable on this instance',
				'AUTH_FAILED',
			);
		}
		return (await res.json()) as Record<string, unknown>;
	}

	/** Instance reachability test. */
	async ping(): Promise<{ ok: boolean; detail?: string }> {
		try {
			await this.ensureAuth();
			const res = await fetch(`${this.base}/api/health`, {
				headers: {
					Accept: 'application/json',
					...(this.#cookie ? { Cookie: this.#cookie } : {}),
				},
				signal: AbortSignal.timeout(10_000),
			});
			if (res.ok) return { ok: true };
			// Health endpoint may not exist on older instances — auth success is enough.
			if (this.#cookie) return { ok: true, detail: 'signed in' };
			return { ok: false, detail: `HTTP ${res.status}` };
		} catch (err) {
			return { ok: false, detail: String(err) };
		}
	}

	/** Catalog search — returns raw items (track-shaped). */
	async search(query: string): Promise<MonochromeTrack[]> {
		await this.ensureAuth();
		const payload = await this.#getJson(`${this.base}/search/?s=${encodeURIComponent(query)}`);
		const data = payload['data'] ?? payload;
		const items = Array.isArray(data)
			? data
			: (((data as Record<string, unknown>)['tracks'] as unknown[] | undefined) ?? []);
		return (items as MonochromeTrack[]).slice(0, 25);
	}

	async getTrackMetadata(id: string): Promise<MonochromeTrack> {
		await this.ensureAuth();
		const payload = await this.#getJson(`${this.base}/info/?id=${encodeURIComponent(id)}`);
		const data = (payload['data'] ?? payload) as unknown;
		const list = Array.isArray(data) ? data : [data];
		const match = list.find(
			(item) =>
				item &&
				typeof item === 'object' &&
				String((item as Record<string, unknown>)['id']) === id,
		) as Record<string, unknown> | undefined;
		const result = (match?.['item'] ?? match ?? undefined) as unknown as
			MonochromeTrack | undefined;
		if (!result) throw new ProviderError(`Monochrome track not found: ${id}`, 'NOT_FOUND');
		return result;
	}

	async resolveStream(trackId: string, _prefs: QualityPreferences): Promise<StreamResolution> {
		const quality = this.#config.quality ?? 'HI_RES_LOSSLESS';
		const params = new URLSearchParams();
		for (const format of getManifestFormatsForQuality(quality))
			params.append('formats', format);
		params.set('adaptive', 'true');
		params.set('manifestType', 'MPEG_DASH');
		params.set('uriScheme', 'HTTPS');
		params.set('usage', 'PLAYBACK');

		await this.ensureAuth();
		const payload = await this.#getJson(
			`${this.base}/trackManifests/?id=${encodeURIComponent(trackId)}&${params.toString()}`,
		);
		const nested = (payload['data'] as Record<string, unknown> | undefined)?.['data'] as
			Record<string, unknown> | undefined;
		const attributes = ((nested?.['attributes'] as Record<string, unknown> | undefined) ??
			(payload['data'] as Record<string, unknown> | undefined)?.['attributes'] ??
			{}) as Record<string, unknown>;
		const uri = attributes['uri'] as string | undefined;
		if (!uri) throw new ProviderError('Monochrome manifest did not include a URI', 'NO_STREAM');

		const manifestRes = await fetch(uri, { signal: AbortSignal.timeout(20_000) });
		if (!manifestRes.ok)
			throw new ProviderError(
				`Manifest fetch failed: HTTP ${manifestRes.status}`,
				'NO_STREAM',
			);
		const manifestText = await manifestRes.text();
		const manifest: DashManifest = parseDashManifest(manifestText, uri);
		const ext = inferDashExtension(manifest.mimeType, manifest.codecs);
		if (ext !== 'flac') {
			throw new ProviderError(
				`Only FLAC outputs are supported currently (got ${manifest.codecs ?? manifest.mimeType ?? 'unknown'}). Configure the instance/quality for LOSSLESS.`,
				'QUALITY_GUARDRAIL',
			);
		}
		const urls = generateDashSegmentUrls(manifest);
		if (urls.length === 0)
			throw new ProviderError('Manifest produced no segment URLs', 'NO_STREAM');
		const resolution: StreamResolution & { segmentUrls: string[] } = {
			url: urls[0],
			format: 'flac',
			ext: 'flac',
			claimedBitrateKbps: null,
			claimedLossless: true,
			// Monochrome HI_RES_LOSSLESS serves up to 24-bit FLAC.
			claimedBitDepth: quality === 'HI_RES_LOSSLESS' ? 24 : 16,
			cipher: 'NONE',
			decryptTrackId: null,
			segmentUrls: urls,
		};
		return resolution;
	}

	/** Downloads + concatenates all DASH segments with progress reporting. */
	async downloadSegments(
		urls: string[],
		destPath: string,
		opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
	): Promise<number> {
		return downloadDashSegments(urls, destPath, opts);
	}
}

/** Standalone: DASH segments need no instance auth (CDN-signed URLs). */
export async function downloadDashSegments(
	urls: string[],
	destPath: string,
	opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<number> {
	const { open } = await import('node:fs/promises');
	const handle = await open(destPath, 'w');
	let written = 0;
	try {
		for (let i = 0; i < urls.length; i++) {
			if (opts.signal?.aborted) throw new Error('aborted');
			let buf: ArrayBuffer | null = null;
			for (let attempt = 0; attempt < 2 && buf === null; attempt++) {
				try {
					const res = await fetch(urls[i], { signal: opts.signal });
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					buf = await res.arrayBuffer();
				} catch (err) {
					if (attempt === 1)
						throw new ProviderError(
							`DASH segment ${i + 1}/${urls.length} failed: ${String(err)}`,
							'PROVIDER_UNAVAILABLE',
						);
					await new Promise((r) => setTimeout(r, 500));
				}
			}
			const bytes = Buffer.from(buf as ArrayBuffer);
			await handle.write(bytes);
			written += bytes.length;
			opts.onProgress?.((i + 1) / urls.length);
		}
	} finally {
		await handle.close();
	}
	log.debug('monochrome segments concatenated', { segments: urls.length, bytes: written });
	return written;
}

/** Maps Monochrome metadata into our generic TrackMeta. */
export function toTrackMeta(track: MonochromeTrack, instanceBase: string): TrackMeta {
	const artists = Array.isArray(track.artists)
		? track.artists.map((a) => (typeof a === 'string' ? a : (a?.name ?? ''))).filter(Boolean)
		: [];
	const artist =
		artists[0] ??
		(typeof track.artist === 'string'
			? track.artist
			: (track.artist?.name ?? 'Unknown Artist'));
	const album =
		typeof track.album === 'string'
			? track.album
			: (track.album?.title ?? track.album?.name ?? null);
	return {
		provider: 'monochrome',
		providerTrackId: String(track.id),
		title: track.title ?? track.name ?? 'Unknown Title',
		artist,
		album,
		albumArtist: artist,
		isrc: track.isrc ?? null,
		trackNumber: track.trackNumber != null ? Number(track.trackNumber) : null,
		discNumber: null,
		durationSec: track.duration != null ? Number(track.duration) : null,
		year: track.releaseDate ? Number.parseInt(track.releaseDate.slice(0, 4), 10) || null : null,
		genre: null,
		coverUrl: null,
		sourceUrl: `${instanceBase}/track/${track.id}`,
		streamToken: null,
	};
}
