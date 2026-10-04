import {
	getManifestFormatsForQuality,
	generateDashSegmentUrls,
	inferDashExtension,
	parseDashManifest,
	type DashManifest,
} from './dash';
import {
	ProviderError,
	type QualityPreferences,
	type StreamResolution,
	type TrackMeta,
} from '$lib/server/providers/types';
import { logger } from '$lib/server/logger';

/**
 * Monochrome client — talks to a self-hosted/instance Monochrome API
 * (TIDAL proxy; reference: atvalerie/monodownload).
 *
 *   GET {base}/info/?id=<trackId>                     → track metadata
 *   GET {base}/trackManifests/?id=…&formats=…         → DASH manifest URI
 *   GET manifest → parse MPD → fetch init+segments    → concatenated audio
 *
 * Auth: HTTP Basic (username/password) when credentials are configured.
 * Only FLAC outputs are supported in Phase 2a (tagging pipeline constraint);
 * AAC-only instances produce an explicit quality error.
 */

const log = logger;

export interface MonochromeConfig {
	instanceUrl: string;
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
	audioQuality?: string;
}

export class MonochromeClient {
	#config: MonochromeConfig;

	constructor(config: MonochromeConfig) {
		this.#config = config;
	}

	get base(): string {
		return this.#config.instanceUrl.replace(/\/+$/, '');
	}

	#authHeaders(): Record<string, string> {
		const { username, password } = this.#config;
		if (username && password) {
			const basic = Buffer.from(`${username}:${password}`).toString('base64');
			return { Authorization: `Basic ${basic}` };
		}
		return {};
	}

	async #getJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const res = await fetch(url, {
			headers: { Accept: 'application/json', ...this.#authHeaders() },
			signal: signal ?? AbortSignal.timeout(20_000),
		});
		if (res.status === 401)
			throw new ProviderError('Monochrome instance rejected credentials', 'AUTH_FAILED');
		if (!res.ok)
			throw new ProviderError(
				`Monochrome request failed: HTTP ${res.status}`,
				'PROVIDER_UNAVAILABLE',
			);
		return (await res.json()) as Record<string, unknown>;
	}

	/** Instance reachability test. */
	async ping(): Promise<{ ok: boolean; detail?: string }> {
		try {
			const res = await fetch(`${this.base}/`, {
				headers: { Accept: 'application/json', ...this.#authHeaders() },
				signal: AbortSignal.timeout(10_000),
			});
			if (res.status === 401)
				return { ok: false, detail: 'Authentication required/rejected' };
			if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
			return { ok: true };
		} catch (err) {
			return { ok: false, detail: String(err) };
		}
	}

	async getTrackMetadata(id: string): Promise<MonochromeTrack> {
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
		isrc: null,
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

export { getManifestFormatsForQuality };
