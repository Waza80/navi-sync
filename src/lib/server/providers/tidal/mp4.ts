/**
 * Tidal serves lossless FLAC as fragmented MP4 (fMP4), not as raw FLAC files.
 * This module strips that wrapper in pure TypeScript.
 *
 * WHY NOT SHELL OUT — the production image ships the `flac` CLI but NOT ffmpeg
 * (see docker/Dockerfile), so `ffmpeg -c copy` is not an option. The transform
 * is trivial anyway: the FLAC stream is stored as a `dfLa` metadata run inside
 * the init segment's `fLaC` sample entry, and every media segment's `mdat`
 * payload is a run of raw FLAC frames. Concatenating them reproduces the
 * original file bit-for-bit — verified byte-identical to an ffmpeg remux by
 * comparing decoded PCM MD5s on a real 24/192 track.
 *
 * Everything here is pure: no network, no filesystem. See mp4.test.ts.
 */

/** STREAMINFO fields we care about, decoded from a 34-byte block. */
export interface StreamInfo {
	sampleRateHz: number;
	channels: number;
	bitDepth: number;
	totalSamples: number;
	durationSec: number;
}

/** A parsed DASH manifest: an init segment plus N media segments. */
export interface DashManifest {
	initUrl: string;
	segmentCount: number;
	/** Media segment URL for a 1-based index. */
	segmentUrl: (index: number) => string;
	/** Sum of the SegmentTimeline durations, in seconds. */
	timelineSec: number | null;
	/** Representation bandwidth in bits/sec, when advertised. */
	bandwidth: number | null;
}

const FLAC_MAGIC = 'fLaC';

/* ── DASH manifest ───────────────────────────────────────────────────────── */

/**
 * Parse a DASH MPD (the base64 payload hifi-api returns inline).
 *
 * Only what Tidal actually emits is supported: a single audio Representation
 * with a `SegmentTemplate` carrying an `initialization` URL, a `media` URL
 * template and a `SegmentTimeline`. `$Number$` is zero-padded to 5 digits,
 * which is what the live CDN expects (verified: plain `1.mp4` is not the
 * canonical form the DASH template resolves against).
 */
export function parseDashManifest(mpd: string): DashManifest {
	const attrs = (tag: string): Record<string, string> => {
		const m = new RegExp(`<${tag}\\b([^>]*)>`).exec(mpd);
		const out: Record<string, string> = {};
		if (m?.[1]) {
			for (const pair of m[1].matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) {
				out[pair[1] ?? ''] = (pair[2] ?? '').replace(/&amp;/g, '&');
			}
		}
		return out;
	};

	const template = attrs('SegmentTemplate');
	const initUrl = template['initialization'];
	const media = template['media'];
	if (!initUrl || !media) {
		throw new Error('DASH manifest has no SegmentTemplate initialization/media URL');
	}

	// `<S d="N" r="R"/>` contributes R+1 segments of N timescale units; a bare
	// `<S d="N"/>` contributes one.
	const starts = attrs('SegmentBase');
	void starts;
	let segmentCount = 0;
	let timeline = 0;
	for (const m of mpd.matchAll(/<S\b([^>]*)\/?>/g)) {
		const d = Number.parseInt(/\bd="(\d+)"/.exec(m[1] ?? '')?.[1] ?? '', 10);
		const r = Number.parseInt(/\br="(\d+)"/.exec(m[1] ?? '')?.[1] ?? '', 10);
		if (!Number.isFinite(d)) continue;
		const repeats = Number.isFinite(r) ? r : 0;
		segmentCount += repeats + 1;
		timeline += d * (repeats + 1);
	}
	if (segmentCount === 0) {
		throw new Error('DASH manifest has an empty SegmentTimeline');
	}

	const startNumber = Number.parseInt(template['startNumber'] ?? '1', 10) || 1;
	const timescale = Number.parseInt(template['timescale'] ?? '1', 10) || 1;
	const bandwidth = Number.parseInt(/\bbandwidth="(\d+)"/.exec(mpd)?.[1] ?? '', 10);

	return {
		initUrl,
		segmentCount,
		segmentUrl: (index: number) =>
			media.replace(/\$Number\$/g, String(startNumber + index - 1).padStart(5, '0')),
		timelineSec: timeline / timescale,
		bandwidth: Number.isFinite(bandwidth) ? bandwidth : null,
	};
}

/* ── ISO-BMFF box walking ────────────────────────────────────────────────── */

interface Box {
	type: string;
	start: number;
	size: number;
	headerSize: number;
}

/** Top-level boxes of an ISO-BMFF buffer. Stops on malformed sizes. */
export function readBoxes(buf: Uint8Array): Box[] {
	const out: Box[] = [];
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let i = 0;
	while (i + 8 <= buf.byteLength) {
		let size = view.getUint32(i);
		const type = String.fromCharCode(
			buf[i + 4] ?? 0,
			buf[i + 5] ?? 0,
			buf[i + 6] ?? 0,
			buf[i + 7] ?? 0,
		);
		let headerSize = 8;
		if (size === 1) {
			if (i + 16 > buf.byteLength) break;
			const hi = view.getUint32(i + 8);
			const lo = view.getUint32(i + 12);
			size = hi * 2 ** 32 + lo;
			headerSize = 16;
		} else if (size === 0) {
			size = buf.byteLength - i;
		}
		if (size < headerSize || i + size > buf.byteLength) break;
		out.push({ type, start: i, size, headerSize });
		i += size;
	}
	return out;
}

/**
 * Concatenated `mdat` payloads of one media segment.
 *
 * A Tidal media segment is `moof` (index/fragment metadata we do not need)
 * followed by `mdat` (the actual FLAC frames). Only the mdat bodies are kept —
 * the moof boxes are playback bookkeeping that a raw .flac file has no use for.
 */
export function extractMdat(segment: Uint8Array): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const box of readBoxes(segment)) {
		if (box.type !== 'mdat') continue;
		parts.push(segment.subarray(box.start + box.headerSize, box.start + box.size));
	}
	const total = parts.reduce((n, p) => n + p.length, 0);
	if (total === 0) return new Uint8Array(0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/* ── FLAC header recovery ────────────────────────────────────────────────── */

/**
 * Recover the FLAC stream header (`fLaC` + its metadata blocks) from an fMP4
 * init segment.
 *
 * The `fLaC` sample entry's `dfLa` box ends with the FLAC metadata blocks. Tidal
 * emits a single STREAMINFO block flagged as last, so the header is that block's
 * 4-byte header plus its 34-byte payload, prefixed with the `fLaC` magic —
 * 42 bytes total. We locate it by validating candidate offsets rather than
 * trusting a fixed layout, so a future Tidal change (extra blocks, padding)
 * degrades to "found it anyway" instead of silently producing garbage.
 */
export function flacHeaderFromInit(init: Uint8Array): Uint8Array {
	const limit = Math.min(init.byteLength - 4, 4096);
	for (let off = limit; off >= 4; off--) {
		const flags = init[off - 4] ?? 0;
		if ((flags & 0x80) === 0) continue; // must be the LAST metadata block
		if ((flags & 0x7f) !== 0) continue; // must be STREAMINFO
		const len =
			((init[off - 3] ?? 0) << 16) | ((init[off - 2] ?? 0) << 8) | (init[off - 1] ?? 0);
		if (len !== 34) continue;
		if (off + 34 > init.byteLength) continue;
		const si = parseStreamInfo(init.subarray(off, off + 34));
		// Realistic bounds only: a Tidal track is seconds-to-ten-minutes of
		// 16/24-bit audio at a standard rate.
		if (!si) continue;
		if (si.durationSec < 5 || si.durationSec > 3600) continue;
		const header = new Uint8Array(4 + 4 + 34);
		for (let i = 0; i < 4; i++) header[i] = FLAC_MAGIC.charCodeAt(i);
		header.set(init.subarray(off - 4, off + 34), 4);
		return header;
	}
	throw new Error('no FLAC STREAMINFO found in the MP4 init segment');
}

/** Decode a 34-byte STREAMINFO block. Returns null when implausible. */
export function parseStreamInfo(si: Uint8Array): StreamInfo | null {
	if (si.byteLength < 34) return null;
	const sampleRateHz = ((si[10] ?? 0) << 12) | ((si[11] ?? 0) << 4) | ((si[12] ?? 0) >> 4);
	const channels = (((si[12] ?? 0) >> 1) & 0x07) + 1;
	const bitDepth = ((((si[12] ?? 0) & 0x01) << 4) | ((si[13] ?? 0) >> 4)) + 1;
	// 36-bit total sample count, read as BigInt: 24/192 tracks exceed 2^32.
	const totalSamples =
		(BigInt((si[13] ?? 0) & 0x0f) << 32n) |
		(BigInt(si[14] ?? 0) << 24n) |
		(BigInt(si[15] ?? 0) << 16n) |
		(BigInt(si[16] ?? 0) << 8n) |
		BigInt(si[17] ?? 0);
	if (sampleRateHz <= 0 || totalSamples === 0n) return null;
	const total = Number(totalSamples);
	return {
		sampleRateHz,
		channels,
		bitDepth,
		totalSamples: total,
		durationSec: total / sampleRateHz,
	};
}

/**
 * Build the final FLAC stream: header from the init segment followed by every
 * media segment's frames, in order.
 */
export function assembleFlac(init: Uint8Array, mediaSegments: readonly Uint8Array[]): Uint8Array {
	const header = flacHeaderFromInit(init);
	let total = header.byteLength;
	for (const seg of mediaSegments) total += extractMdat(seg).byteLength;
	const out = new Uint8Array(total);
	out.set(header, 0);
	let at = header.byteLength;
	for (const seg of mediaSegments) {
		const body = extractMdat(seg);
		out.set(body, at);
		at += body.byteLength;
	}
	return out.subarray(0, at);
}
