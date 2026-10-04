import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, qualityLabel } from './format';

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
