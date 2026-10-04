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

describe('LiveEventClient reactivity', () => {
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
