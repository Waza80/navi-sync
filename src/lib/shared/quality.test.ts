import { describe, expect, it } from 'vitest';
import {
	isSameRecording,
	normalizeFormat,
	qualityRank,
	shouldSkipRefetch,
	shouldStopAlreadyDownloaded,
	type QualityDescriptor,
} from './quality';

/**
 * These encode the rule the user's request depends on: once a song is 24-bit we
 * stop fetching it, and below that we keep trying. A regression here means
 * either an endless refetch loop or a library that quietly stops improving.
 */

const FLAC24 = { format: 'flac', bitrateKbps: null, bitDepth: 24, isLossless: true };
const FLAC16 = { format: 'flac', bitrateKbps: null, bitDepth: 16, isLossless: true };
const MP3_320 = { format: 'mp3', bitrateKbps: 320, bitDepth: null, isLossless: false };
const MP3_128 = { format: 'mp3', bitrateKbps: 128, bitDepth: null, isLossless: false };

describe('qualityRank', () => {
	it('ranks 24-bit FLAC at the ceiling', () => {
		expect(qualityRank(FLAC24)).toBe(4);
	});
	it('ranks 16-bit FLAC above any MP3', () => {
		expect(qualityRank(FLAC16)).toBe(3);
		expect(qualityRank(MP3_320)).toBe(2);
		expect(qualityRank(MP3_128)).toBe(1);
	});
	it('treats a FLAC with unknown depth as 16-bit, not 24', () => {
		// Must not default to 24 — that would fake reaching the ceiling.
		expect(
			qualityRank({ format: 'flac', bitrateKbps: null, bitDepth: null, isLossless: true }),
		).toBe(3);
	});
	it('honours isLossless even when the format string disagrees', () => {
		expect(
			qualityRank({ format: 'm4a', bitrateKbps: null, bitDepth: 24, isLossless: true }),
		).toBe(4);
	});
	it('ranks unknown formats below everything understood', () => {
		expect(
			qualityRank({ format: 'aac', bitrateKbps: 256, bitDepth: null, isLossless: false }),
		).toBe(0);
	});

	// music-metadata reports an MP3's container as "MPEG". Without normalizing
	// that, every uploaded MP3 ranked 0 ("unknown") — worse than a 128 kbps
	// file — so the guardrail mishandled perfectly good uploads.
	it('treats a "mpeg" container as mp3, not as unknown', () => {
		expect(
			qualityRank({ format: 'mpeg', bitrateKbps: 320, bitDepth: null, isLossless: false }),
		).toBe(2);
		expect(
			qualityRank({ format: 'mpeg', bitrateKbps: 128, bitDepth: null, isLossless: false }),
		).toBe(1);
	});

	it('normalizes case and the MPEG variants', () => {
		for (const f of ['MPEG', 'Mpeg', 'mpeg-1', 'mpeg2', ' mp3 ']) {
			expect(
				qualityRank({ format: f, bitrateKbps: 320, bitDepth: null, isLossless: false }),
			).toBe(2);
		}
	});

	it('normalizes a FLAC container alias to lossless', () => {
		expect(
			qualityRank({ format: 'X-FLAC', bitrateKbps: null, bitDepth: 16, isLossless: false }),
		).toBe(3);
	});
});

describe('normalizeFormat', () => {
	it('maps containers to the families the ranker understands', () => {
		expect(normalizeFormat('MPEG')).toBe('mp3');
		expect(normalizeFormat('mp3')).toBe('mp3');
		expect(normalizeFormat('FLAC')).toBe('flac');
		expect(normalizeFormat('mp4')).toBe('aac');
		expect(normalizeFormat('VORBIS')).toBe('ogg');
	});

	it('passes anything else through lowercased and trimmed', () => {
		expect(normalizeFormat('WAV')).toBe('wav');
		expect(normalizeFormat('  Weird ')).toBe('weird');
	});
});

describe('24-bit ceiling', () => {
	it('refuses to replace a 24-bit file with anything', () => {
		expect(shouldSkipRefetch(FLAC24, FLAC16).skip).toBe(true);
		expect(shouldSkipRefetch(FLAC24, MP3_320).skip).toBe(true);
		expect(shouldSkipRefetch(FLAC24, FLAC24).skip).toBe(true);
	});

	it('names the ceiling as the reason', () => {
		expect(shouldSkipRefetch(FLAC24, FLAC16).reason).toBe('24bit_ceiling_reached');
	});
});

describe('below the ceiling, upgrades proceed', () => {
	it('upgrades 16-bit FLAC with 24-bit FLAC', () => {
		const v = shouldSkipRefetch(FLAC16, FLAC24);
		expect(v.skip).toBe(false);
		expect(v.reason).toBeNull();
	});

	it('upgrades MP3 with any FLAC', () => {
		expect(shouldSkipRefetch(MP3_320, FLAC16).skip).toBe(false);
		expect(shouldSkipRefetch(MP3_128, FLAC24).skip).toBe(false);
	});

	it('does not replace lossless with lossy of any bitrate', () => {
		expect(shouldSkipRefetch(FLAC16, MP3_320).skip).toBe(true);
		expect(shouldSkipRefetch(FLAC16, MP3_128).skip).toBe(true);
	});

	it('does not replace an equal-quality file', () => {
		expect(shouldSkipRefetch(FLAC16, FLAC16).skip).toBe(true);
		expect(shouldSkipRefetch(MP3_320, MP3_320).skip).toBe(true);
	});

	it('allows a 320 upgrade over a low-bitrate MP3', () => {
		expect(shouldSkipRefetch(MP3_128, MP3_320).skip).toBe(false);
	});
});

describe('fallback policy', () => {
	it('permits a sub-320 MP3 when lower fallback is enabled', () => {
		expect(shouldSkipRefetch({ ...MP3_128, isLossless: false }, MP3_128).skip).toBe(false);
	});

	it('refuses a sub-320 MP3 when lower fallback is disabled', () => {
		const v = shouldSkipRefetch(MP3_128, MP3_128, { allowLowerFallback: false });
		expect(v.skip).toBe(true);
		expect(v.reason).toBe('below_min_bitrate_and_fallback_disabled');
	});

	it('still allows lossless when fallback is disabled', () => {
		expect(shouldSkipRefetch(MP3_320, FLAC16, { allowLowerFallback: false }).skip).toBe(false);
	});
});

describe('isSameRecording', () => {
	it('matches on equal ISRC regardless of case', () => {
		expect(isSameRecording('USQX91300108', 'usqx91300108')).toBe(true);
	});
	it('refuses on missing ISRCs', () => {
		expect(isSameRecording(null, 'USQX91300108')).toBe(false);
		expect(isSameRecording('USQX91300108', null)).toBe(false);
		expect(isSameRecording(null, null)).toBe(false);
	});
	it('refuses across different ISRCs', () => {
		expect(isSameRecording('USQX91300108', 'USQX91300109')).toBe(false);
	});
});

describe('the upgrade loop terminates', () => {
	it('converges: repeated 24-bit offers stop after the first success', () => {
		// Simulates the sweep running hourly against an unchanged catalogue.
		// Widened so the loop can hold any tier as the track improves.
		let existing: QualityDescriptor = MP3_320;
		let fetches = 0;
		for (let hour = 0; hour < 50; hour++) {
			if (shouldSkipRefetch(existing, FLAC24).skip) break;
			existing = FLAC24;
			fetches++;
		}
		expect(fetches).toBe(1);
		expect(qualityRank(existing)).toBe(4);
	});

	it('does not thrash when the best available offer is only 16-bit', () => {
		let existing: QualityDescriptor = MP3_320;
		let fetches = 0;
		for (let hour = 0; hour < 50; hour++) {
			if (shouldSkipRefetch(existing, FLAC16).skip) break;
			existing = FLAC16;
			fetches++;
		}
		// One upgrade to 16-bit, then it stops — it must NOT keep refetching.
		expect(fetches).toBe(1);
		expect(qualityRank(existing)).toBe(3);
	});
});

describe('shouldStopAlreadyDownloaded', () => {
	// Regression: the quality guardrail only skips when the incoming copy cannot be
	// better, so a higher-ranked copy came back, got tagged (different bytes), and
	// moveIntoLibrary wrote "… (2).flac" / "(3).flac" beside the original. Navidrome
	// then saw several files claiming one track number and greyed the album out.
	it('stops when the recording already has a file', () => {
		expect(shouldStopAlreadyDownloaded({ hasFileOnDisk: true, isUpgrade: false })).toEqual({
			skip: true,
			reason: 'already_downloaded',
		});
	});

	it('lets an explicit upgrade through — replacing the file is its whole point', () => {
		expect(shouldStopAlreadyDownloaded({ hasFileOnDisk: true, isUpgrade: true })).toEqual({
			skip: false,
			reason: null,
		});
	});

	it('never stops when there is nothing on disk', () => {
		expect(shouldStopAlreadyDownloaded({ hasFileOnDisk: false, isUpgrade: false })).toEqual({
			skip: false,
			reason: null,
		});
		expect(shouldStopAlreadyDownloaded({ hasFileOnDisk: false, isUpgrade: true })).toEqual({
			skip: false,
			reason: null,
		});
	});
});
