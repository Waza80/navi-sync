import { open } from 'node:fs/promises';
import { ProviderError } from '$lib/server/providers/types';
import { extractMdat, flacHeaderFromInit, parseStreamInfo, type StreamInfo } from './mp4';

/**
 * Tidal segment downloader.
 *
 * Tidal serves lossless FLAC as fragmented MP4: one init segment plus ~90
 * independent media segments, each a separate object on Tidal's CDN. They are
 * NOT range requests into one stream, so there is no byte offset to seek to —
 * the correct implementation is "fetch many, concatenate in order".
 *
 * Why this is simple where the old Cloudflare-capped downloader was not:
 *   - no Content-Range negotiation, so no range to verify against
 *   - no per-connection time budget, so no chunk sizing or retry storms
 *   - throughput is ~5-7 MiB/s, so a full-length track lands in seconds
 *
 * Memory is bounded by fetching in batches of `concurrency` and appending each
 * batch in order: a 24/192 track is 256 MiB and must never be held whole.
 */

export interface SegmentPlan {
	initUrl: string;
	mediaUrls: string[];
	/** Optional size hint (manifest bandwidth × timeline) for progress only. */
	expectedBytes?: number | null;
}

export interface DownloadOptions {
	signal?: AbortSignal;
	concurrency?: number;
	maxRetries?: number;
	onProgress?: (receivedBytes: number, totalBytes: number | null) => void;
}

export interface DownloadResult {
	bytes: number;
	streamInfo: StreamInfo;
}

/** Bytes a response should yield, or null when the origin does not say. */
function contentLength(res: Response): number | null {
	const raw = res.headers.get('content-length');
	if (!raw) return null;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchBuffer(
	url: string,
	opts: DownloadOptions,
	timeoutMs = 45_000,
): Promise<Uint8Array> {
	const res = await fetch(url, {
		headers: { Accept: '*/*', 'User-Agent': 'NaviSync/1.0' },
		signal: opts.signal ?? AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const buf = new Uint8Array(await res.arrayBuffer());
	// A CDN error page served with 200 would otherwise land in the file as
	// audio. Every segment must be a real box sequence.
	if (buf.byteLength < 8) throw new Error(`segment too small (${buf.byteLength} bytes)`);
	return buf;
}

/**
 * Download a Tidal track's segments and write a plain FLAC file to `destPath`.
 *
 * Retries are per segment and cheap because segments are small (~400 KB) and
 * independent — a failure costs one segment, never the whole track.
 */
export async function downloadTidalFlac(
	plan: SegmentPlan,
	destPath: string,
	opts: DownloadOptions = {},
): Promise<DownloadResult> {
	const concurrency = Math.max(1, Math.min(opts.concurrency ?? 8, 16));
	const maxRetries = opts.maxRetries ?? 4;

	const initUrl = plan.initUrl;
	const mediaUrls = plan.mediaUrls;
	if (!initUrl || mediaUrls.length === 0) {
		throw new ProviderError('Tidal manifest produced no segments to download', 'NO_STREAM');
	}

	// Recover the FLAC header first: if the init segment is unusable we fail
	// before writing a single byte rather than after the whole transfer.
	const init = await retry(() => fetchBuffer(initUrl, opts), maxRetries, 'init segment');
	let header: Uint8Array;
	try {
		header = flacHeaderFromInit(init);
	} catch (err) {
		throw new ProviderError(
			`Tidal init segment carried no FLAC header: ${err instanceof Error ? err.message : String(err)}`,
			'PROVIDER_UNAVAILABLE',
		);
	}
	const streamInfo = parseStreamInfo(header.subarray(8, 42));
	if (!streamInfo) {
		throw new ProviderError('Tidal init segment had an unreadable STREAMINFO', 'NO_STREAM');
	}

	const totalHint = plan.expectedBytes ?? null;
	let received = 0;
	const handle = await open(destPath, 'w');
	try {
		await handle.write(header, 0, header.byteLength, 0);
		received = header.byteLength;

		// Batch the fetches so ordering is trivial and memory stays bounded.
		for (let start = 0; start < mediaUrls.length; start += concurrency) {
			if (opts.signal?.aborted) throw new Error('aborted');
			const batch = mediaUrls.slice(start, start + concurrency);
			const parts = await Promise.all(
				batch.map((url, i) =>
					retry(
						async () => {
							const seg = await fetchBuffer(url, opts);
							const body = extractMdat(seg);
							if (body.byteLength === 0) {
								throw new Error('media segment contained no mdat box');
							}
							return body;
						},
						maxRetries,
						`segment ${start + i + 1}`,
					),
				),
			);
			// Append strictly in order — audio frames are not self-describing.
			for (const part of parts) {
				await handle.write(part, 0, part.byteLength, received);
				received += part.byteLength;
			}
			opts.onProgress?.(received, totalHint);
		}
	} finally {
		await handle.close();
	}

	if (received <= header.byteLength) {
		throw new ProviderError('Tidal download produced no audio frames', 'NO_STREAM');
	}
	return { bytes: received, streamInfo };
}

async function retry<T>(fn: () => Promise<T>, attempts: number, label: string): Promise<T> {
	let lastErr: Error | null = null;
	for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err instanceof Error ? err : new Error(String(err));
			// Exponential backoff with jitter: CDN hiccups tend to cluster, so
			// spreading retries avoids re-colliding with the same edge.
			if (attempt < attempts - 1) {
				const backoff = Math.min(250 * 2 ** attempt, 5000);
				await new Promise((r) => setTimeout(r, backoff * (0.5 + Math.random())));
			}
		}
	}
	throw new ProviderError(
		`Tidal ${label} failed after ${attempts} attempts: ${lastErr?.message ?? 'unknown error'}`,
		'PROVIDER_UNAVAILABLE',
	);
}

export { contentLength };
