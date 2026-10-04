import { logger } from '$lib/server/logger';

/**
 * Cover image fetching for enrichment. Given a candidate artwork URL (from any
 * metadata source) or a plain artist/album pair, return JPEG bytes — or null.
 * Every failure is swallowed: a missing cover must never fail a repair.
 */

const log = logger;
const TIMEOUT_MS = 20_000;
const MIN_BYTES = 1024;
const MAX_BYTES = 20 * 1024 * 1024;

/** Naive image sniff — avoids fetching a 404 HTML page into a .jpg file. */
function looksLikeImage(buf: Buffer): boolean {
	if (buf.length < MIN_BYTES) return false;
	// JPEG: FF D8 FF · PNG: 89 50 4E 47 · WEBP: RIFF....WEBP
	return (
		(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
		(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ||
		(buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP')
	);
}

export async function fetchImage(url: string): Promise<Buffer | null> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) return null;
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length > MAX_BYTES || !looksLikeImage(buf)) return null;
		return buf;
	} catch (err) {
		log.debug('cover fetch failed', { url: url.slice(0, 120), error: String(err) });
		return null;
	}
}

/**
 * Try a list of candidate artwork URLs in order and return the first usable
 * image. Later candidates act as fallbacks (e.g. Cover Art Archive 404 → Apple
 * Music artwork).
 */
export async function fetchFirstImage(
	urls: Array<string | null | undefined>,
): Promise<Buffer | null> {
	const seen = new Set<string>();
	for (const url of urls) {
		if (!url || seen.has(url)) continue;
		seen.add(url);
		const buf = await fetchImage(url);
		if (buf) return buf;
	}
	return null;
}
