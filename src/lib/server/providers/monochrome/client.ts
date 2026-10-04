import {
	ProviderError,
	type StreamResolution,
	type QualityPreferences,
} from '$lib/server/providers/types';
/**
 * Monochrome client v2 — tracks.monochrome.st instance.
 *
 * Verified live (2026-10):
 *   GET {base}/search?q=<query>   → {tracks:[{id, title, artistNames[],
 *                                    artwork, duration(ms), isrc, releaseId}]}
 *   GET {base}/track/<id>         → RAW DECRYPTED FLAC STREAM (no cipher,
 *                                   no manifests — the instance handles
 *                                   TIDAL server-side; no Range support).
 *
 * Metadata for bare ids is not retrievable — the dashboard always enqueues
 * from search results, so the metadata snapshot travels in the job payload
 * (see queue/handlers.ts).
 */

export interface MonochromeConfig {
	instanceUrl: string;
	quality?: 'HI_RES_LOSSLESS' | 'LOSSLESS' | 'LOW';
}

export interface MonochromeTrack {
	id: string;
	title: string;
	artist: string;
	album: string | null;
	durationSec: number | null;
	isrc: string | null;
	artworkUrl: string | null;
}

interface SearchResponse {
	tracks?: Array<{
		id?: string;
		trackId?: string;
		title?: string;
		artistNames?: string[];
		artwork?: string;
		duration?: number;
		isrc?: string;
		playable?: boolean;
	}>;
	releases?: Array<{
		id?: string;
		releaseId?: string;
		title?: string;
		artistNames?: string[];
		artwork?: string;
	}>;
}

export class MonochromeClient {
	#config: MonochromeConfig;

	constructor(config: MonochromeConfig) {
		this.#config = config;
	}

	get base(): string {
		return this.#config.instanceUrl.replace(/\/+$/, '');
	}

	#accept = { Accept: 'application/json', 'User-Agent': 'NaviSync/0.2' };

	/** Instance reachability + search probe. */
	async ping(): Promise<{ ok: boolean; detail?: string }> {
		try {
			const tracks = await this.search('the');
			return { ok: true, detail: `search returned ${tracks.length} results` };
		} catch (err) {
			return { ok: false, detail: err instanceof Error ? err.message : String(err) };
		}
	}

	async search(query: string): Promise<MonochromeTrack[]> {
		const res = await fetch(`${this.base}/search?q=${encodeURIComponent(query)}`, {
			headers: this.#accept,
			signal: AbortSignal.timeout(20_000),
		});
		const body = (await res.json().catch(() => null)) as
			SearchResponse | { detail?: string } | null;
		if (!res.ok || !body) {
			const detail = (body as { detail?: string } | null)?.detail;
			throw new ProviderError(
				detail ?? `Monochrome search failed: HTTP ${res.status}`,
				'PROVIDER_UNAVAILABLE',
			);
		}
		const { tracks = [] } = body as SearchResponse;
		return tracks
			.filter((t) => (t.id ?? t.trackId) != null)
			.map((t) => ({
				id: String(t.id ?? t.trackId),
				title: t.title ?? 'Unknown Title',
				artist: (t.artistNames ?? [])[0] ?? 'Unknown Artist',
				album: null,
				durationSec: t.duration != null ? Math.round(t.duration / 1000) : null,
				isrc: t.isrc ?? null,
				artworkUrl: t.artwork ?? null,
			}));
	}

	/**
	 * Track metadata by id via the instance `/info/` endpoint (same item
	 * shape as search results, optionally wrapped in `{ data }` or `{ item }`).
	 * Throws NOT_FOUND when the id is unknown — callers fall back gracefully.
	 */
	async getTrackMetadata(id: string): Promise<MonochromeTrack> {
		const res = await fetch(`${this.base}/info/?id=${encodeURIComponent(id)}`, {
			headers: this.#accept,
			signal: AbortSignal.timeout(20_000),
		});
		if (!res.ok) {
			throw new ProviderError(
				`Monochrome track lookup failed: HTTP ${res.status}`,
				res.status === 404 ? 'NOT_FOUND' : 'PROVIDER_UNAVAILABLE',
			);
		}
		const parsed: unknown = await res.json().catch(() => null);
		if (!parsed || typeof parsed !== 'object') {
			throw new ProviderError('Monochrome track lookup failed', 'PROVIDER_UNAVAILABLE');
		}
		const record = parsed as { data?: unknown; item?: unknown };
		const data = record.data ?? parsed;
		const list: unknown[] = Array.isArray(data) ? data : [data];
		const isRecord = (v: unknown): v is Record<string, unknown> =>
			typeof v === 'object' && v !== null;
		const textOf = (item: unknown, key: string): string | null => {
			if (!isRecord(item)) return null;
			const v = item[key];
			return typeof v === 'string' ? v : null;
		};
		const match = list.find(
			(item) => (textOf(item, 'id') ?? textOf(item, 'trackId') ?? '') === id,
		);
		const inner = isRecord(match) ? match['item'] : undefined;
		const raw = (isRecord(inner) ? inner : isRecord(match) ? match : null) as {
			id?: string;
			trackId?: string;
			title?: string;
			name?: string;
			artistNames?: string[];
			artist?: string;
			artwork?: string;
			duration?: number;
			isrc?: string;
		} | null;
		if (!raw) throw new ProviderError(`Monochrome track not found: ${id}`, 'NOT_FOUND');
		const artists = Array.isArray(raw.artistNames)
			? raw.artistNames.filter((a): a is string => typeof a === 'string')
			: [];
		return {
			id: String(raw.id ?? raw.trackId ?? id),
			title:
				typeof raw.title === 'string'
					? raw.title
					: typeof raw.name === 'string'
						? raw.name
						: 'Unknown Title',
			artist: artists[0] ?? (typeof raw.artist === 'string' ? raw.artist : 'Unknown Artist'),
			album: null,
			durationSec: typeof raw.duration === 'number' ? Math.round(raw.duration / 1000) : null,
			isrc: typeof raw.isrc === 'string' ? raw.isrc : null,
			artworkUrl: typeof raw.artwork === 'string' ? raw.artwork : null,
		};
	}

	/**
	 * Resolves the direct FLAC stream URL. The instance serves the decrypted
	 * stream itself (verified: first bytes are `fLaC`), so no decryption.
	 */
	resolveStream(trackId: string, _prefs: QualityPreferences): StreamResolution {
		const quality = this.#config.quality ?? 'HI_RES_LOSSLESS';
		return {
			url: `${this.base}/track/${encodeURIComponent(trackId)}`,
			format: 'flac',
			ext: 'flac',
			claimedBitrateKbps: null,
			claimedLossless: true,
			claimedBitDepth: quality === 'HI_RES_LOSSLESS' ? 24 : 16,
			cipher: 'NONE',
			decryptTrackId: null,
			chunked: true,
		};
	}
}

export { ProviderError };

/* ── chunked downloader ─────────────────────────────────────────────────── */

/**
 * Cloudflare on these instances caps every connection at ~512KiB / ~30s.
 * Monochrome supports HTTP Ranges (206 + Content-Range), so we download in
 * parallel offset chunks with per-chunk retry and write directly at offsets.
 */
export async function downloadChunked(
	url: string,
	destPath: string,
	opts: {
		signal?: AbortSignal;
		onProgress?: (receivedBytes: number, totalBytes: number) => void;
		concurrency?: number;
		chunkSize?: number;
	} = {},
): Promise<number> {
	const { open } = await import('node:fs/promises');

	// 1. Probe total size.
	const probe = await fetch(url, {
		headers: { Range: 'bytes=0-0', ...baseHeadersOf(url) },
		signal: opts.signal ?? AbortSignal.timeout(35_000),
	});
	const contentRange = probe.headers.get('content-range'); // bytes 0-0/TOTAL
	await probe.arrayBuffer();
	const total = Number.parseInt((contentRange ?? '').split('/')[1] ?? '', 10);
	if (!Number.isFinite(total) || total <= 0) {
		throw new ProviderError(
			'Instance did not report Content-Range total',
			'PROVIDER_UNAVAILABLE',
		);
	}

	const chunkSize = opts.chunkSize ?? 480 * 1024; // safely under the 512KiB cap
	const starts: Array<{ start: number; end: number }> = [];
	for (let start = 0; start < total; start += chunkSize) {
		starts.push({ start, end: Math.min(start + chunkSize, total) - 1 });
	}

	const handle = await open(destPath, 'w+');
	await handle.truncate(total); // preallocate — chunks write at offsets
	let received = 0;
	let next = 0;
	let aborted = false;
	opts.signal?.addEventListener('abort', () => (aborted = true), { once: true });

	async function worker(): Promise<void> {
		for (;;) {
			if (aborted) throw new Error('aborted');
			const index = next++;
			if (index >= starts.length) return;
			const { start, end } = starts[index];
			let lastErr: Error | null = null;
			for (let attempt = 0; attempt < 5; attempt++) {
				if (aborted) throw new Error('aborted');
				try {
					const res = await fetch(url, {
						headers: { Range: `bytes=${start}-${end}`, ...baseHeadersOf(url) },
						signal: AbortSignal.timeout(40_000),
					});
					if (res.status !== 206 && res.status !== 200) {
						throw new Error(`HTTP ${res.status}`);
					}
					const buf = Buffer.from(await res.arrayBuffer());
					const expected = end - start + 1;
					if (buf.length !== expected)
						throw new Error(`short chunk ${buf.length}/${expected}`);
					await handle.write(buf, 0, buf.length, start);
					received += buf.length;
					opts.onProgress?.(received, total);
					lastErr = null;
					break;
				} catch (err) {
					lastErr = err instanceof Error ? err : new Error(String(err));
					await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
				}
			}
			if (lastErr)
				throw new ProviderError(
					`Chunk ${index} failed after retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
					'PROVIDER_UNAVAILABLE',
				);
		}
	}

	const concurrency = opts.concurrency ?? 8;
	try {
		await Promise.all(Array.from({ length: concurrency }, () => worker()));
	} finally {
		await handle.close();
	}
	return total;
}

function baseHeadersOf(url: string): Record<string, string> {
	void url;
	return {
		'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
	};
}
