import { describe, expect, it } from 'vitest';
import {
	qualityRank,
	shouldSkipRefetch,
	selectBestQuality,
	isSameRecording,
	type QualityDescriptor,
} from './quality';

const flac24: QualityDescriptor = {
	format: 'flac',
	bitrateKbps: null,
	bitDepth: 24,
	isLossless: true,
};
const flac16: QualityDescriptor = {
	format: 'flac',
	bitrateKbps: null,
	bitDepth: 16,
	isLossless: true,
};
const mp3_320: QualityDescriptor = {
	format: 'mp3',
	bitrateKbps: 320,
	bitDepth: null,
	isLossless: false,
};
const mp3_128: QualityDescriptor = {
	format: 'mp3',
	bitrateKbps: 128,
	bitDepth: null,
	isLossless: false,
};

describe('qualityRank', () => {
	it('orders tiers correctly', () => {
		expect(qualityRank(flac24)).toBe(4);
		expect(qualityRank(flac16)).toBe(3);
		expect(qualityRank(mp3_320)).toBe(2);
		expect(qualityRank(mp3_128)).toBe(1);
	});
	it('treats flac format as lossless even if flag missing', () => {
		expect(
			qualityRank({ format: 'flac', bitrateKbps: null, bitDepth: null, isLossless: false }),
		).toBe(3);
	});
});

describe('shouldSkipRefetch (24-bit ceiling guardrail)', () => {
	it('always skips when 24-bit exists — hard stop', () => {
		const verdict = shouldSkipRefetch(flac24, flac24);
		expect(verdict.skip).toBe(true);
		expect(verdict.reason).toBe('24bit_ceiling_reached');
	});
	it('skips when equal-or-better quality exists', () => {
		expect(shouldSkipRefetch(mp3_320, mp3_320).skip).toBe(true);
		expect(shouldSkipRefetch(flac16, mp3_320).skip).toBe(true);
	});
	it('allows upgrade from lower tiers', () => {
		expect(shouldSkipRefetch(mp3_128, mp3_320).skip).toBe(false);
		expect(shouldSkipRefetch(mp3_320, flac16).skip).toBe(false);
	});
	it('blocks sub-320 fallback when fallback disabled', () => {
		const verdict = shouldSkipRefetch(mp3_128, mp3_128, { allowLowerFallback: false });
		expect(verdict.skip).toBe(true);
		expect(verdict.reason).toBe('below_min_bitrate_and_fallback_disabled');
	});
});

describe('selectBestQuality', () => {
	it('prefers lossless when policy asks', () => {
		const r = selectBestQuality([mp3_320, flac16, mp3_128], {
			preferLossless: true,
			minBitrateKbps: 320,
			allowLowerFallback: true,
		});
		expect(r.chosen).toBe(flac16);
		expect(r.reason).toBe('lossless_available');
	});
	it('falls back to highest candidate meeting the bitrate floor', () => {
		const r = selectBestQuality([mp3_320, mp3_128], {
			preferLossless: false,
			minBitrateKbps: 320,
			allowLowerFallback: true,
		});
		expect(r.chosen).toBe(mp3_320);
	});
	it('returns null when nothing meets the floor and fallback is disabled', () => {
		const r = selectBestQuality([mp3_128], {
			preferLossless: true,
			minBitrateKbps: 320,
			allowLowerFallback: false,
		});
		expect(r.chosen).toBeNull();
		expect(r.reason).toBe('no_candidate_meets_min_bitrate');
	});
	it('uses fallback tier only when allowed', () => {
		const allowed = selectBestQuality([mp3_128], {
			preferLossless: true,
			minBitrateKbps: 320,
			allowLowerFallback: true,
		});
		expect(allowed.chosen).toBe(mp3_128);
		expect(allowed.reason).toBe('lower_fallback');
	});
});

describe('isSameRecording (supersede identity)', () => {
	it('matches equal ISRCs case-insensitively', () => {
		expect(isSameRecording('USSM11300080', 'ussm11300080')).toBe(true);
	});
	it('rejects different ISRCs', () => {
		expect(isSameRecording('USSM11300080', 'USSM11300081')).toBe(false);
	});
	it('never matches when either side is missing (no guessing)', () => {
		expect(isSameRecording(null, 'USSM11300080')).toBe(false);
		expect(isSameRecording('USSM11300080', null)).toBe(false);
		expect(isSameRecording(null, null)).toBe(false);
		expect(isSameRecording('', 'USSM11300080')).toBe(false);
	});
});
