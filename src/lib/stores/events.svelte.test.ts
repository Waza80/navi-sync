import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for the dashboard queue reactivity complaint:
 * "progress bar standing still / stale entries until filter switching".
 *
 * The store must apply events even for jobs it has never seen (missed
 * `job.queued` during an SSE reconnect) and must always REPLACE entries so
 * every Map.set is a reactive trigger.
 */

interface FakeES {
	onmessage: ((ev: { data: string }) => void) | null;
	onopen: (() => void) | null;
	onerror: (() => void) | null;
	close: () => void;
	addEventListener: (...args: unknown[]) => void;
}

const instances: FakeES[] = [];

beforeEach(() => {
	instances.length = 0;
	vi.resetModules();
	const FakeEventSource = class {
		onmessage: ((ev: { data: string }) => void) | null = null;
		onopen: (() => void) | null = null;
		onerror: (() => void) | null = null;
		constructor(_url: string) {
			instances.push(this);
		}
		close(): void {}
		addEventListener(...args: unknown[]): void {
			void args;
		}
	};
	vi.stubGlobal('window', {});
	vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function lastES(): FakeES {
	const es = instances.at(-1);
	if (!es) throw new Error('no EventSource constructed');
	return es;
}

async function freshStore() {
	const mod = await import('$lib/stores/events.svelte');
	return mod.live;
}

const ts = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const progressEvt = (jobId: string, progress: number, stage: string): string =>
	JSON.stringify({
		type: 'job.progress',
		jobId,
		jobType: 'download',
		trackId: null,
		progress,
		stage,
		ts: ts(1),
	});

const statusEvt = (type: string, jobId: string): string =>
	JSON.stringify({
		type,
		jobId,
		jobType: 'metadata_repair',
		trackId: null,
		progress: 0,
		stage: null,
		error: null,
		ts: ts(1),
	});

describe('LiveEventClient reactivity', () => {
	// NOTE: the regression that made every badge read 0 — `#counts` declared as a
	// plain class field instead of `$state` — CANNOT be asserted here. $effect does
	// not run in this harness (no component context, and flushSync does not drive
	// it), so a "did the getter re-trigger" test would pass or fail for reasons
	// unrelated to the code. That gap is precisely why it shipped: the store was
	// already reactive everywhere else and this one field was not.
	//
	// What IS asserted below is the delta arithmetic, which is the part that is
	// testable, plus the guard that stops a seed compounding a wrong number.

	it('live SSE events move the totals by a status delta', async () => {
		const live = await freshStore();
		live.start();
		// Authoritative totals first: deltas are ignored until real numbers arrive,
		// otherwise a seed would compound into a wrong count.
		live.jobCounts = { total: 100, active: 0, byStatus: { succeeded: 100 } };
		live.start();

		lastES().onmessage?.({ data: statusEvt('job.queued', 'job-a') });
		expect(live.jobCounts.byStatus['queued']).toBe(1);
		expect(live.jobCounts.active).toBe(1);
		// A job the store had never seen IS a new row, so total grows by one.
		expect(live.jobCounts.total).toBe(101);

		lastES().onmessage?.({ data: progressEvt('job-a', 5, 'working') });
		expect(live.jobCounts.byStatus['queued']).toBe(0);
		expect(live.jobCounts.byStatus['running']).toBe(1);
		expect(live.jobCounts.active).toBe(1);

		lastES().onmessage?.({ data: statusEvt('job.completed', 'job-a') });
		expect(live.jobCounts.byStatus['running']).toBe(0);
		expect(live.jobCounts.byStatus['succeeded']).toBe(101);
		expect(live.jobCounts.active).toBe(0);
		// A second job is another new row.
		lastES().onmessage?.({ data: statusEvt('job.queued', 'job-c') });
		expect(live.jobCounts.total).toBe(102);
	});

	it('ignores deltas until the server has supplied real totals', async () => {
		const live = await freshStore();
		live.start();
		lastES().onmessage?.({ data: statusEvt('job.queued', 'job-b') });
		// No authoritative counts yet — a delta here would compound a wrong number.
		expect(live.jobCounts.total).toBe(0);
		expect(live.jobCounts.byStatus['queued']).toBeUndefined();
	});

	it('applies progress events for UNKNOWN jobs (missed queued event)', async () => {
		const live = await freshStore();
		live.start();
		lastES().onmessage?.({ data: progressEvt('job-x', 42, 'downloading') });
		const job = live.jobs.get('job-x');
		expect(job).toBeDefined();
		expect(job?.status).toBe('running');
		expect(job?.progress).toBe(42);
		expect(job?.stage).toBe('downloading');
		expect(live.recentJobs[0]?.id).toBe('job-x');
	});

	it('progress replaces the whole entry (reactive trigger guaranteed)', async () => {
		const live = await freshStore();
		live.start();
		lastES().onmessage?.({ data: progressEvt('job-y', 10, 'a') });
		const first = live.jobs.get('job-y');
		lastES().onmessage?.({ data: progressEvt('job-y', 55, 'b') });
		const second = live.jobs.get('job-y');
		expect(second).not.toBe(first);
		expect(second?.progress).toBe(55);
		expect(second?.stage).toBe('b');
	});

	it('hydrate overwrites stale entries (missed SSE during reconnect)', async () => {
		const live = await freshStore();
		live.start();
		lastES().onmessage?.({ data: progressEvt('job-z', 30, 'old stage') });
		live.hydrate([
			{
				id: 'job-z',
				type: 'download',
				status: 'succeeded',
				priority: 5,
				progress: 100,
				stage: 'done',
				error: null,
				attempts: 1,
				maxAttempts: 3,
				trackId: null,
				createdAt: ts(2),
				finishedAt: ts(3),
			},
		]);
		expect(live.jobs.get('job-z')?.status).toBe('succeeded');
	});

	it('pruneNotIn drops cleared entries', async () => {
		const live = await freshStore();
		live.start();
		lastES().onmessage?.({ data: progressEvt('keep', 1, 'x') });
		lastES().onmessage?.({ data: progressEvt('drop', 1, 'x') });
		const keep = live.jobs.get('keep');
		if (!keep) throw new Error('missing keep');
		live.pruneNotIn([keep]);
		expect(live.jobs.has('keep')).toBe(true);
		expect(live.jobs.has('drop')).toBe(false);
	});

	it('reconnect (error → open) fires the resync callback once', async () => {
		const live = await freshStore();
		let resyncs = 0;
		live.start(undefined, () => resyncs++);
		lastES().onopen?.();
		expect(resyncs).toBe(0);
		lastES().onerror?.();
		lastES().onopen?.();
		expect(resyncs).toBe(1);
	});
});
