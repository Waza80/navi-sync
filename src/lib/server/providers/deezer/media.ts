import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getDeezerSession } from './gateway';
import { decryptStripeFile } from './blowfish';
import {
	ProviderError,
	type QualityPreferences,
	type StreamResolution,
} from '$lib/server/providers/types';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';

const log = logger;

/**
 * Media resolution + download.
 *   POST https://media.deezer.com/v1/get_url
 *     { license_token, media: [{type:'FULL', formats:[{cipher:'BF_CBC_STRIPE',
 *        format: 'FLAC'|'MP3_320'|'MP3_128'}…]}], track_tokens: [token] }
 *
 * Formats are requested best-first; the server returns what the account tier
 * permits. Local decryption is the default (no third party sees track ids);
 * DEEZER_RESOLVER_URL optionally enables an external dzmedia-compatible
 * resolver (returns pre-cleared URLs) as a fallback, mirroring the echo
 * extension's secondary path.
 */

const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36';

type FormatId = 'FLAC' | 'MP3_320' | 'MP3_128';

function requestedFormats(prefs: QualityPreferences): FormatId[] {
	const ordered: FormatId[] = prefs.preferLossless
		? ['FLAC', 'MP3_320', 'MP3_128']
		: ['MP3_320', 'MP3_128', 'FLAC'];
	return ordered.filter((f) => {
		if (!prefs.allowLowerFallback && f === 'MP3_128' && prefs.minBitrateKbps > 128)
			return false;
		return true;
	});
}

interface MediaSource {
	url?: string;
}

interface MediaEntry {
	/** v1 shape: {https}; v2 shape: [{url}] */
	sources?: { https?: string } | MediaSource[];
	format?: string;
	/** v1: string; v2: {type: string} */
	cipher?: string | { type?: string } | null;
}

function sourceUrlOf(entry: MediaEntry): string | null {
	if (Array.isArray(entry.sources)) {
		for (const s of entry.sources) {
			if (s?.url) return s.url;
		}
		return null;
	}
	return entry.sources?.https ?? null;
}

function cipherOf(entry: MediaEntry): 'BF_CBC_STRIPE' | 'NONE' {
	const c = entry.cipher;
	const type = typeof c === 'string' ? c : c?.type;
	return type === 'BF_CBC_STRIPE' ? 'BF_CBC_STRIPE' : 'NONE';
}

interface GetUrlResponse {
	data?: Array<{ media?: MediaEntry[] }>;
	errors?: Array<{ code?: number; message?: string }>;
}

export async function resolveStream(
	trackToken: string,
	trackId: string,
	prefs: QualityPreferences,
): Promise<StreamResolution> {
	const session = await getDeezerSession();

	if (env.DEEZER_RESOLVER_URL) {
		try {
			return await resolveViaExternal(trackId, prefs);
		} catch (err) {
			log.warn('external resolver failed, falling back to local gateway path', {
				error: String(err),
			});
		}
	}

	const formats = requestedFormats(prefs);
	if (formats.length === 0) {
		throw new ProviderError(
			'Quality policy excludes all available formats',
			'QUALITY_GUARDRAIL',
		);
	}

	const res = await fetch('https://media.deezer.com/v1/get_url', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
		body: JSON.stringify({
			license_token: session.licenseToken,
			media: [
				{
					type: 'FULL',
					formats: formats.map((f) => ({ cipher: 'BF_CBC_STRIPE', format: f })),
				},
			],
			track_tokens: [trackToken],
		}),
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) {
		throw new ProviderError(`media/get_url HTTP ${res.status}`, 'PROVIDER_UNAVAILABLE');
	}
	const body = (await res.json()) as GetUrlResponse;
	if (body.errors && body.errors.length > 0) {
		throw new ProviderError(`media/get_url error: ${JSON.stringify(body.errors)}`, 'NO_STREAM');
	}
	const media = body.data?.[0]?.media ?? [];
	if (media.length === 0) {
		throw new ProviderError(
			`No stream available (tier/region). Response: ${JSON.stringify(body).slice(0, 250)}`,
			'NO_STREAM',
		);
	}
	const entry = pickBestMedia(media);
	const url = sourceUrlOf(entry);
	if (!url || !entry.format) {
		throw new ProviderError(
			`Media entry missing URL. Entry: ${JSON.stringify(entry).slice(0, 250)}`,
			'NO_STREAM',
		);
	}
	const cipher = cipherOf(entry);
	const { format, ext, bitrate, lossless, bitDepth } = describeFormat(entry.format);
	return {
		url,
		format,
		ext,
		claimedBitrateKbps: bitrate,
		claimedLossless: lossless,
		claimedBitDepth: bitDepth,
		cipher,
		decryptTrackId: cipher === 'BF_CBC_STRIPE' ? trackId : null,
	};
}

function pickBestMedia(entries: MediaEntry[]): MediaEntry {
	const order: Record<string, number> = { FLAC: 3, MP3_320: 2, MP3_128: 1 };
	const sorted = [...entries].sort(
		(a, b) => (order[b.format ?? ''] ?? 0) - (order[a.format ?? ''] ?? 0),
	);
	return sorted[0] ?? entries[0];
}

function describeFormat(f: string): {
	format: 'mp3' | 'flac';
	ext: 'mp3' | 'flac';
	bitrate: number | null;
	lossless: boolean;
	bitDepth: number | null;
} {
	if (f.includes('FLAC'))
		return { format: 'flac', ext: 'flac', bitrate: null, lossless: true, bitDepth: 16 };
	if (f.includes('320'))
		return { format: 'mp3', ext: 'mp3', bitrate: 320, lossless: false, bitDepth: null };
	return { format: 'mp3', ext: 'mp3', bitrate: 128, lossless: false, bitDepth: null };
}

/** External dzmedia-compatible resolver (echo's getMediaUrl path). */
async function resolveViaExternal(
	trackId: string,
	prefs: QualityPreferences,
): Promise<StreamResolution> {
	if (!env.DEEZER_RESOLVER_URL)
		throw new ProviderError('resolver not configured', 'PROVIDER_UNAVAILABLE');
	const ordered: string[] = prefs.preferLossless
		? ['FLAC', 'MP3_320', 'MP3_128']
		: ['MP3_320', 'MP3_128'];
	const res = await fetch(`${env.DEEZER_RESOLVER_URL.replace(/\/$/, '')}/get_url`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ formats: ordered, ids: [Number(trackId)] }),
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new ProviderError(`resolver HTTP ${res.status}`, 'PROVIDER_UNAVAILABLE');
	const body = (await res.json()) as GetUrlResponse;
	const entry = pickBestMedia(body.data?.[0]?.media ?? []);
	const url = sourceUrlOf(entry);
	if (!url || !entry.format) throw new ProviderError('resolver returned no URL', 'NO_STREAM');
	const { format, ext, bitrate, lossless, bitDepth } = describeFormat(entry.format);
	return {
		url,
		format,
		ext,
		claimedBitrateKbps: bitrate,
		claimedLossless: lossless,
		claimedBitDepth: bitDepth,
		// External resolvers return pre-decrypted streams.
		cipher: 'NONE',
		decryptTrackId: null,
	};
}

export interface DownloadResult {
	filePath: string;
	bytes: number;
	sha256Encrypted: string;
}

/**
 * Download the resolved URL to `destPath` (encrypted form, if any).
 * Progress callback receives 0..1 based on content-length when available.
 */
export async function downloadToFile(
	url: string,
	destPath: string,
	opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<DownloadResult> {
	let res: Response;
	try {
		res = await fetch(url, { signal: opts.signal, redirect: 'follow' });
	} catch (err) {
		throw new ProviderError(`stream download failed: ${String(err)}`, 'PROVIDER_UNAVAILABLE');
	}
	if (!res.ok || !res.body) {
		throw new ProviderError(`stream download HTTP ${res.status}`, 'PROVIDER_UNAVAILABLE');
	}
	const totalHeader = res.headers.get('content-length');
	const total = totalHeader ? Number.parseInt(totalHeader, 10) : null;
	const hash = createHash('sha256');
	let received = 0;
	let lastReported = -1;

	const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
	const out = createWriteStream(destPath);
	const MILESTONE = 5 * 1024 * 1024; // streams without content-length: every 5 MB
	let nextMilestone = MILESTONE;
	nodeStream.on('data', (chunk: Buffer) => {
		received += chunk.length;
		hash.update(chunk);
		if (opts.onProgress) {
			if (total) {
				const pct = Math.floor((received / total) * 100);
				if (pct !== lastReported) {
					lastReported = pct;
					opts.onProgress(received / total);
				}
			} else if (received >= nextMilestone) {
				nextMilestone += MILESTONE;
				opts.onProgress(-1); // sentinel: unknown total
			}
		}
	});
	opts.signal?.addEventListener('abort', () => nodeStream.destroy(new Error('aborted')), {
		once: true,
	});
	await pipeline(nodeStream, out);

	return { filePath: destPath, bytes: received, sha256Encrypted: hash.digest('hex') };
}

export { decryptStripeFile, unlink };
