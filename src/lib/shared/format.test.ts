import { describe, expect, it } from 'vitest';
import {
	formatBytes,
	formatDuration,
	formatRelativeTime,
	qualityLabel,
	sampleRateLabel,
} from './format';

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
	it('says HI-RES instead of the depth, keeping the rate', () => {
		// A third chip for hi-res crowded the row and pushed the lyrics badge out.
		// HI-RES also says more than "24-bit", which no longer distinguishes a
		// 24/44.1 file from a 24/192 one.
		expect(qualityLabel('flac', null, 24, 96_000)).toBe('HI-RES 96 kHz');
		expect(qualityLabel('flac', null, 24, 192_000)).toBe('HI-RES 192 kHz');
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

describe('formatRelativeTime', () => {
	const now = Date.UTC(2026, 0, 2, 12, 0, 0);
	it('says "just now" below 45 s, then whole minutes', () => {
		expect(formatRelativeTime(now - 10_000, now)).toBe('just now');
		expect(formatRelativeTime(now - 44_999, now)).toBe('just now');
		expect(formatRelativeTime(now - 45_000, now)).toBe('1 min ago');
		expect(formatRelativeTime(now - 3 * 60_000, now)).toBe('3 min ago');
		expect(formatRelativeTime(now - 59 * 60_000, now)).toBe('59 min ago');
	});
	it('counts hours, then whole days', () => {
		expect(formatRelativeTime(now - 60 * 60_000, now)).toBe('1 h ago');
		expect(formatRelativeTime(now - 23 * 3_600_000, now)).toBe('23 h ago');
		expect(formatRelativeTime(now - 24 * 3_600_000, now)).toBe('1 d ago');
		expect(formatRelativeTime(now - 47 * 3_600_000, now)).toBe('1 d ago');
		expect(formatRelativeTime(now - 48 * 3_600_000, now)).toBe('2 d ago');
	});
	it('parses ISO strings (what the API returns)', () => {
		expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5 min ago');
	});
	it('clamps a future timestamp instead of printing a negative age', () => {
		expect(formatRelativeTime(now + 90_000, now)).toBe('just now');
	});
	it('handles null/undefined/unparseable', () => {
		expect(formatRelativeTime(null, now)).toBe('—');
		expect(formatRelativeTime(undefined, now)).toBe('—');
		expect(formatRelativeTime('not a date', now)).toBe('—');
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
