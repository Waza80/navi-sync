import { describe, expect, it } from 'vitest';

/**
 * The rule the worker enforces, mirrored as a pure predicate so it is testable
 * without a queue.
 *
 * An UPGRADE failure is not a download failure. A locally adopted track is
 * present, filed and playing; an upgrade that finds no better stream available is
 * a routine outcome and says nothing about the track's own state. Marking such a
 * row `failed` put songs you could hear into the failed list — and the dashboard's
 * remove-from-database control acts on the ROW, so following that prompt would
 * have deleted the file of a track that had never failed.
 */
export function failureActionFor(payload: {
	retryForTrackId?: string;
	upgradeForTrackId?: string;
}): 'none' | 'mark-failed' {
	if (payload.upgradeForTrackId && !payload.retryForTrackId) return 'none';
	if (payload.retryForTrackId ?? payload.upgradeForTrackId) return 'mark-failed';
	return 'none';
}

describe('an upgrade failure is not a download failure', () => {
	it('leaves a completed track alone when only the upgrade failed', () => {
		expect(failureActionFor({ upgradeForTrackId: 'track-1' })).toBe('none');
	});

	it('still marks failed when the download itself is retried and fails', () => {
		expect(failureActionFor({ retryForTrackId: 'track-1' })).toBe('mark-failed');
	});

	it('treats an upgrade carrying a retry target as a retry', () => {
		// The retry asks again for the file itself, so its failure is meaningful and
		// the status must reflect it.
		expect(failureActionFor({ upgradeForTrackId: 'track-1', retryForTrackId: 'track-1' })).toBe(
			'mark-failed',
		);
	});

	it('does nothing without a target, leaving it to the shadow-row guard', () => {
		expect(failureActionFor({})).toBe('none');
	});
});
