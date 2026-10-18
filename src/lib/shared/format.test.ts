import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, qualityLabel, sampleRateLabel } from './format';

describe('formatDuration', () => {
	it('formats mm:ss under an hour', () => {
		expect(formatDuration(61)).toBe('1:01');
		expect(formatDuration(3545)).toBe('59:05');
	});
	it('formats h:mm:ss above an hour', () => {
		expect(formatDuration(3671)).toBe('1:01:11');
	});
	it('handles null/undefined/non-finite', () => {
		expect(formatDuration(null)).toBe('—');
		expect(formatDuration(Number.NaN)).toBe('—');
	});
});

describe('formatBytes', () => {
	it('formats KB/MB/GB', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(2048)).toBe('2.0 KB');
		expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
	});
	it('handles null', () => {
		expect(formatBytes(null)).toBe('—');
	});
});

describe('qualityLabel', () => {
	it('labels flac with bit depth', () => {
		expect(qualityLabel('flac', null, 24)).toBe('FLAC 24-bit');
		expect(qualityLabel('flac', null, null)).toBe('FLAC 16-bit');
	});
	it('labels mp3 with bitrate', () => {
		expect(qualityLabel('mp3', 320, null)).toBe('MP3 320k');
	});
});

describe('qualityLabel with a sample rate', () => {
	it('names the rate for a hi-res file', () => {
		expect(qualityLabel('flac', null, 24, 96_000)).toBe('FLAC 24-bit · 96 kHz');
		expect(qualityLabel('flac', null, 24, 192_000)).toBe('FLAC 24-bit · 192 kHz');
	});

	it('omits the rate at CD rate, where it says nothing', () => {
		// "FLAC 16-bit · 44.1 kHz" on every track in the library is noise on a chip
		// that also carries the lyrics badge.
		expect(qualityLabel('flac', null, 16, 44_100)).toBe('FLAC 16-bit');
		expect(qualityLabel('flac', null, 24, 44_100)).toBe('FLAC 24-bit');
		expect(qualityLabel('flac', null, 24, 48_000)).toBe('FLAC 24-bit');
	});

	it('omits an unknown rate rather than guessing one', () => {
		expect(qualityLabel('flac', null, 24, null)).toBe('FLAC 24-bit');
		expect(qualityLabel('flac', null, 24, undefined)).toBe('FLAC 24-bit');
	});

	it('never adds a rate to a lossy label', () => {
		expect(qualityLabel('mp3', 320, null, 44_100)).toBe('MP3 320k');
	});
});

describe('sampleRateLabel', () => {
	it('spells 44.1 the way a sleeve does', () => {
		expect(sampleRateLabel(44_100)).toBe('44.1 kHz');
		expect(sampleRateLabel(48_000)).toBe('48 kHz');
		expect(sampleRateLabel(96_000)).toBe('96 kHz');
		expect(sampleRateLabel(192_000)).toBe('192 kHz');
	});
	it('returns null for nothing recorded', () => {
		expect(sampleRateLabel(null)).toBeNull();
		expect(sampleRateLabel(undefined)).toBeNull();
		expect(sampleRateLabel(0)).toBeNull();
	});
});
