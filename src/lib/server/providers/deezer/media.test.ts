import { describe, expect, it } from 'vitest';
import { describeFormat, requestedFormats } from './media';

/**
 * The Deezer hi-res tier.
 *
 * `FLAC_24` did not exist when this client was written and was never requested,
 * so every hi-res master on Deezer was fetched as 16/44.1. Verified live
 * 2026-10 against Pink Floyd — Money (116914026): `FLAC` returns 40.3 MiB,
 * `FLAC_24` returns 134.7 MiB, and ffprobe reads the latter as 24-bit/96 kHz.
 */
const PREFS = { preferLossless: true, minBitrateKbps: 320, allowLowerFallback: true };

describe('requestedFormats', () => {
	it('asks for the hi-res tier first', () => {
		expect(requestedFormats(PREFS)[0]).toBe('FLAC_24');
	});

	it('keeps CD-quality lossless behind it, not instead of it', () => {
		// Requesting an ungranted format ALONE fails with
		// "License token has no sufficient rights" (error 1002), which the app
		// reads as NO_STREAM. Only ~1 track in 7 has a hi-res master, so dropping
		// the fallbacks would break most downloads to chase the few.
		const order = requestedFormats(PREFS);
		expect(order).toContain('FLAC');
		expect(order).toContain('MP3_320');
		expect(order.indexOf('FLAC_24')).toBeLessThan(order.indexOf('FLAC'));
	});

	it('omits hi-res when the user declines it', () => {
		expect(requestedFormats({ ...PREFS, preferHiRes: false })).not.toContain('FLAC_24');
		// …without losing lossless. Declining hi-res is a storage decision, not a
		// decision to stop fetching lossless.
		expect(requestedFormats({ ...PREFS, preferHiRes: false })).toContain('FLAC');
	});

	it('still prefers MP3 first when lossless is declined', () => {
		const order = requestedFormats({ ...PREFS, preferLossless: false });
		expect(order[0]).toBe('MP3_320');
		expect(order.indexOf('FLAC_24')).toBeGreaterThan(order.indexOf('MP3_128'));
	});

	it('drops the 128 kbps tier when lower fallback is disabled', () => {
		expect(
			requestedFormats({ ...PREFS, allowLowerFallback: false, minBitrateKbps: 320 }),
		).not.toContain('MP3_128');
	});

	it('keeps the 128 kbps tier when lower fallback is allowed', () => {
		expect(requestedFormats(PREFS)).toContain('MP3_128');
	});
});

describe('describeFormat', () => {
	it('claims 24-bit for the hi-res id, with no sample rate', () => {
		// The rate is genuinely not in the response — the id is the whole contract.
		// Claiming one would be inventing it; `qualityRank` reads null as "possibly
		// hi-res" and the file is measured immediately after download.
		expect(describeFormat('FLAC_24')).toMatchObject({
			format: 'flac',
			ext: 'flac',
			bitDepth: 24,
			lossless: true,
			sampleRateHz: null,
		});
	});

	it('claims 16-bit for the ordinary lossless id', () => {
		expect(describeFormat('FLAC')).toMatchObject({
			format: 'flac',
			bitDepth: 16,
			sampleRateHz: null,
		});
	});

	it('matches FLAC_24 before FLAC', () => {
		// `includes('FLAC')` is true for 'FLAC_24' too, so the order of these two
		// checks is the difference between 24-bit and 16-bit.
		expect(describeFormat('FLAC_24').bitDepth).toBe(24);
		expect(describeFormat('FLAC').bitDepth).toBe(16);
	});

	it('reads the lossy tiers', () => {
		expect(describeFormat('MP3_320')).toMatchObject({
			format: 'mp3',
			bitrate: 320,
			lossless: false,
		});
		expect(describeFormat('MP3_128')).toMatchObject({
			format: 'mp3',
			bitrate: 128,
			lossless: false,
		});
	});
});
