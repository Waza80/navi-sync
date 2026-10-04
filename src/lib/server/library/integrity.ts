import { open } from 'node:fs/promises';

/**
 * Audio integrity verification — catches SILENT TRUNCATION.
 *
 * A Cloudflare-capped instance can hand back a wrong (too small) Content-Range
 * total. Every ranged chunk then "succeeds", the file is preallocated to the
 * short size, and a valid-looking FLAC with a correct `fLaC` magic lands in
 * the library — playable-looking but missing most of the track.
 *
 * The only reliable defence is to read the file's own header after assembly and
 * compare its declared duration against the track duration the provider
 * promised. STREAMINFO is a fixed 34-byte block right after the `fLaC` magic,
 * so this costs one small read rather than a full decode.
 */

export interface FlacStreamInfo {
	sampleRateHz: number;
	channels: number;
	bitDepth: number;
	totalSamples: number;
	durationSec: number;
}

export interface IntegrityVerdict {
	ok: boolean;
	/** Duration declared by the file itself, when it could be read. */
	actualDurationSec: number | null;
	expectedDurationSec: number | null;
	bitDepth: number | null;
	sampleRateHz: number | null;
	reason: string | null;
}

/**
 * Parse the STREAMINFO metadata block of a FLAC file.
 * Returns null when the file is not FLAC or the header is unreadable.
 */
export async function readFlacStreamInfo(path: string): Promise<FlacStreamInfo | null> {
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(path, 'r');
		// "fLaC" (4) + first metadata block header (4) = 8 bytes to STREAMINFO.
		const header = Buffer.alloc(8);
		const { bytesRead } = await handle.read(header, 0, 8, 0);
		if (bytesRead < 8 || header.toString('ascii', 0, 4) !== 'fLaC') return null;
		// First block must be STREAMINFO (type 0).
		if ((header[4] & 0x7f) !== 0) return null;

		const si = Buffer.alloc(34);
		await handle.read(si, 0, 34, 8);

		const sampleRateHz = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
		const channels = ((si[12] >> 1) & 0x07) + 1;
		const bitDepth = (((si[12] & 0x01) << 4) | (si[13] >> 4)) + 1;
		const totalSamples = (BigInt(si[13] & 0x0f) << 32n) | BigInt(si.readUInt32BE(14));
		if (sampleRateHz <= 0 || totalSamples === 0n) return null;

		return {
			sampleRateHz,
			channels,
			bitDepth,
			totalSamples: Number(totalSamples),
			durationSec: Number(totalSamples) / sampleRateHz,
		};
	} catch {
		return null;
	} finally {
		await handle?.close();
	}
}

/**
 * Verify a downloaded FLAC is the RIGHT, COMPLETE track.
 *
 * `expectedDurationSec` comes from the provider's catalog metadata. This
 * compares it against the duration the file's own STREAMINFO declares, which
 * catches the two failures that matter most in practice: the instance served a
 * 30s PREVIEW for a full-length track, or it served a different recording.
 *
 * SCOPE — what this does NOT catch: a file cut off MID-FRAME still declares
 * its full intended length, because STREAMINFO is written by the encoder and
 * is not derived from the bytes actually present. That case is prevented
 * upstream in `downloadChunked`, which verifies every response's Content-Range
 * against the range it requested.
 *
 * Tolerance is generous by default (2s): providers round durations and
 * encoders pad slightly, so this avoids false rejections while still catching
 * anything more than a rounding difference short.
 */
export async function verifyFlacIntegrity(
	path: string,
	expectedDurationSec: number | null,
	toleranceSec = 2,
): Promise<IntegrityVerdict> {
	const info = await readFlacStreamInfo(path);
	if (!info) {
		return {
			ok: false,
			actualDurationSec: null,
			expectedDurationSec,
			bitDepth: null,
			sampleRateHz: null,
			reason: 'not a readable FLAC (bad or missing fLaC/STREAMINFO header)',
		};
	}
	const actual = info.durationSec;
	if (
		expectedDurationSec == null ||
		!Number.isFinite(expectedDurationSec) ||
		expectedDurationSec <= 0
	) {
		// Nothing to compare against — the header parsed, so accept it.
		return {
			ok: true,
			actualDurationSec: actual,
			expectedDurationSec,
			bitDepth: info.bitDepth,
			sampleRateHz: info.sampleRateHz,
			reason: null,
		};
	}
	const shortfall = expectedDurationSec - actual;
	if (shortfall > toleranceSec) {
		return {
			ok: false,
			actualDurationSec: actual,
			expectedDurationSec,
			bitDepth: info.bitDepth,
			sampleRateHz: info.sampleRateHz,
			reason:
				`short stream: file declares ${actual.toFixed(1)}s but the track is ` +
				`${expectedDurationSec.toFixed(1)}s (${shortfall.toFixed(1)}s missing) — ` +
				`the instance likely served a preview or the wrong recording`,
		};
	}
	return {
		ok: true,
		actualDurationSec: actual,
		expectedDurationSec,
		bitDepth: info.bitDepth,
		sampleRateHz: info.sampleRateHz,
		reason: null,
	};
}

/**
 * Coarse sanity net for a server-reported content length, applied BEFORE any
 * bytes are written.
 *
 * Deliberately very wide (≈32 kB/s … 16 Mb/s): a truncated-FLAC report and a
 * legitimate 128 kbps MP3 of the same length are nearly indistinguishable from
 * size alone (both ≈16 kB/s), so this must not try to be clever. Its only job
 * is rejecting absurd values (an origin returning a few hundred bytes, or a
 * total beyond any conceivable encoding). The real gate is
 * `verifyFlacIntegrity` after assembly, which reads the file's own header.
 */
export function plausibleByteLength(
	totalBytes: number,
	expectedDurationSec: number | null,
): boolean {
	if (!Number.isFinite(totalBytes) || totalBytes <= 0) return false;
	if (
		expectedDurationSec == null ||
		!Number.isFinite(expectedDurationSec) ||
		expectedDurationSec <= 0
	) {
		return true;
	}
	const perSecond = totalBytes / expectedDurationSec;
	// 4 kB/s (≈32 kbps, generous low end) .. 2 MB/s (16 Mb/s, generous high end)
	return perSecond >= 4_000 && perSecond <= 2_000_000;
}
