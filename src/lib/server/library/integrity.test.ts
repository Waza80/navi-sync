import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plausibleByteLength, readFlacStreamInfo, verifyFlacIntegrity } from './integrity';

let dir: string;

/**
 * Build a FLAC file whose STREAMINFO declares a given sample rate /
 * total-samples, optionally padded with junk audio frames. This lets us
 * reproduce exactly the failure mode seen on the Cloudflare-capped instance:
 * a file with valid `fLaC` magic whose length is far short of the real track.
 */
async function makeFlac(
	name: string,
	sampleRate: number,
	channels: number,
	bitDepth: number,
	totalSamples: number,
	extraBytes = 0,
): Promise<string> {
	const si = Buffer.alloc(34);
	// Bit-packed STREAMINFO: 16 minBlock | 16 maxBlock | 24 minFrame | 24 maxFrame
	// | 20 sampleRate | 3 (channels-1) | 5 (bitDepth-1) | 36 totalSamples | 128 md5
	//
	// BigInt is required: the totalSamples field is 36 bits wide, and JS's
	// `>>` is 32-bit (so `v >> 35` silently wraps to `v >> 3`).
	const bits: number[] = [];
	const push = (value: bigint, width: number): void => {
		for (let i = BigInt(width - 1); i >= 0n; i--) {
			bits.push(Number((value >> i) & 1n));
		}
	};
	push(4096n, 16); // min block size
	push(4096n, 16); // max block size
	push(0n, 24); // min frame size
	push(0n, 24); // max frame size
	push(BigInt(sampleRate), 20);
	push(BigInt(channels - 1), 3);
	push(BigInt(bitDepth - 1), 5);
	push(BigInt(totalSamples), 36);
	push(0n, 128); // MD5 — unused
	for (let byte = 0; byte < 34; byte++) {
		let b = 0;
		for (let k = 0; k < 8; k++) b = (b << 1) | (bits[byte * 8 + k] ?? 0);
		si[byte] = b;
	}

	const blockHeader = Buffer.from([0x00, 0x00, 0x00, 34]); // type 0, len 34
	const path = join(dir, name);
	await writeFile(
		path,
		Buffer.concat([Buffer.from('fLaC', 'ascii'), blockHeader, si, Buffer.alloc(extraBytes, 0)]),
	);
	return path;
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'integrity-'));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('readFlacStreamInfo', () => {
	it('parses sample rate, channels, bit depth and duration', async () => {
		// 44100 Hz, stereo, 16-bit, 174 s
		const path = await makeFlac('ok.flac', 44100, 2, 16, 44100 * 174, 4096);
		const info = await readFlacStreamInfo(path);
		expect(info).not.toBeNull();
		expect(info!.sampleRateHz).toBe(44100);
		expect(info!.channels).toBe(2);
		expect(info!.bitDepth).toBe(16);
		expect(info!.durationSec).toBeCloseTo(174, 1);
	});

	it('reads 24-bit hi-res correctly', async () => {
		const path = await makeFlac('hires.flac', 96000, 2, 24, 96000 * 60, 1024);
		const info = await readFlacStreamInfo(path);
		expect(info!.bitDepth).toBe(24);
		expect(info!.sampleRateHz).toBe(96000);
		expect(info!.durationSec).toBeCloseTo(60, 1);
	});

	it('returns null for a non-FLAC file', async () => {
		const path = join(dir, 'notaflac.mp3');
		await writeFile(path, Buffer.alloc(2048, 1));
		expect(await readFlacStreamInfo(path)).toBeNull();
	});

	it('returns null for a file that does not exist', async () => {
		expect(await readFlacStreamInfo(join(dir, 'missing.flac'))).toBeNull();
	});
});

describe('verifyFlacIntegrity', () => {
	it('accepts a complete file', async () => {
		const path = await makeFlac('full.flac', 44100, 2, 16, 44100 * 174, 18_000_000);
		const v = await verifyFlacIntegrity(path, 174);
		expect(v.ok).toBe(true);
		expect(v.reason).toBeNull();
		expect(v.actualDurationSec).toBeCloseTo(174, 1);
	});

	it('REJECTS a short stream (e.g. a 30s preview served for a 174s track)', async () => {
		// This is the check's real purpose: the header self-reports its length,
		// so comparing it against the catalog catches an instance serving a
		// PREVIEW or the wrong recording — not a mid-file byte truncation
		// (which downloadChunked prevents by verifying every Content-Range).
		const path = await makeFlac('preview.flac', 44100, 2, 16, 44100 * 30, 2_950_000);
		const v = await verifyFlacIntegrity(path, 174);
		expect(v.ok).toBe(false);
		expect(v.reason).toMatch(/short/);
		expect(v.reason).toContain('174.0s');
	});

	it('cannot detect a mid-file byte truncation from the header alone', async () => {
		// Documents the boundary honestly: STREAMINFO declares the intended
		// length regardless of how many audio bytes actually follow.
		const path = await makeFlac('cut.flac', 44100, 2, 16, 44100 * 174, 100);
		const v = await verifyFlacIntegrity(path, 174);
		expect(v.ok).toBe(true);
		expect(v.actualDurationSec).toBeCloseTo(174, 1);
	});

	it('rejects a file whose header cannot be read at all', async () => {
		const path = join(dir, 'broken.flac');
		await writeFile(path, Buffer.alloc(9000, 0));
		const v = await verifyFlacIntegrity(path, 174);
		expect(v.ok).toBe(false);
		expect(v.reason).toMatch(/not a readable FLAC/);
	});

	it('accepts when no expected duration is known', async () => {
		const path = await makeFlac('unknown.flac', 44100, 2, 16, 44100 * 100, 4096);
		const v = await verifyFlacIntegrity(path, null);
		expect(v.ok).toBe(true);
		expect(v.actualDurationSec).toBeCloseTo(100, 1);
	});

	it('tolerates small provider rounding differences', async () => {
		const path = await makeFlac('rounded.flac', 44100, 2, 16, 44100 * 173, 4096);
		expect((await verifyFlacIntegrity(path, 174)).ok).toBe(true);
	});
});

describe('plausibleByteLength', () => {
	it('rejects absurd totals far outside any plausible encoding', () => {
		expect(plausibleByteLength(512, 174)).toBe(false); // origin returned a stub
		expect(plausibleByteLength(2_000_000_000, 174)).toBe(false);
	});

	it('does NOT try to outsmart the duration check on borderline sizes', () => {
		// 2,951,585 bytes / 174s ≈ 17 KB/s — indistinguishable from a legit
		// 128 kbps MP3 by size alone, so the coarse net must let it through and
		// leave the verdict to verifyFlacIntegrity.
		expect(plausibleByteLength(2_951_585, 174)).toBe(true);
	});

	it('accepts a realistic lossless size', () => {
		expect(plausibleByteLength(19_785_845, 174)).toBe(true);
	});

	it('accepts 128kbps MP3-sized payloads', () => {
		expect(plausibleByteLength(2_784_000, 174)).toBe(true); // ~128 kbps
	});

	it('rejects nonsense totals', () => {
		expect(plausibleByteLength(0, 174)).toBe(false);
		expect(plausibleByteLength(-5, 174)).toBe(false);
		expect(plausibleByteLength(Number.NaN, 174)).toBe(false);
	});

	it('cannot judge without a duration', () => {
		expect(plausibleByteLength(19_785_845, null)).toBe(true);
	});
});
