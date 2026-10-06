import { SvelteMap } from 'svelte/reactivity';
import { isNaviEvent, type JobDTO, type NaviEvent } from '$lib/shared/types';

/**
 * Live event client (SSE). Backed by Postgres NOTIFY → /api/events —
 * no polling anywhere in the UI.
 *
 * Reactivity contract (keep it boring on purpose):
 *  - every event application REPLACES the map entry with a fresh object
 *    (Map.set is the reactive trigger; no reliance on nested mutation);
 *  - events for unknown jobs create entries (reconnect gaps);
 *  - reconnects trigger a snapshot resync callback so missed events are
 *    backfilled from the authoritative load();
 *  - hydrate() overwrites AND pruneNotIn() removes — the server snapshot is
 *    always the source of truth.
 */
/** Authoritative per-status job totals, counted over the whole table. */
export interface JobCounts {
	total: number;
	active: number;
	byStatus: Record<string, number>;
}

class LiveEventClient {
	jobs = new SvelteMap<string, JobDTO>();
	connected = $state(false);
	#source: EventSource | null = null;
	#everConnected = false;
	#onTerminal: (() => void) | null = null;
	#onResync: (() => void) | null = null;

	/** Idempotent. Call once from the dashboard page (browser only). */
	start(onTerminal?: () => void, onResync?: () => void): void {
		if (typeof window === 'undefined' || this.#source) return;
		this.#onTerminal = onTerminal ?? null;
		this.#onResync = onResync ?? null;
		const es = new EventSource('/api/events');
		this.#source = es;
		es.onopen = () => {
			const resync = this.#everConnected && !this.connected; // reconnect after a drop
			this.connected = true;
			this.#everConnected = true;
			if (resync) this.#onResync?.();
		};
		es.onerror = () => {
			this.connected = false; // EventSource auto-reconnects
		};
		es.addEventListener('hello', () => {
			this.connected = true;
			this.#everConnected = true;
		});
		es.onmessage = (evt) => {
			try {
				const parsed: unknown = JSON.parse(String(evt.data));
				if (isNaviEvent(parsed)) this.#apply(parsed);
			} catch {
				// ignore malformed frames
			}
		};
	}

	stop(): void {
		this.#source?.close();
		this.#source = null;
		this.connected = false;
	}

	/** Replace state with the authoritative server snapshot. */
	hydrate(jobs: JobDTO[]): void {
		this.jobs.clear();
		for (const j of jobs) this.jobs.set(j.id, { ...j });
	}

	/** Drop entries absent from the authoritative snapshot (post-clear). */
	pruneNotIn(jobs: JobDTO[]): void {
		const ids = jobs.map((j) => j.id);
		for (const id of [...this.jobs.keys()]) {
			if (!ids.includes(id)) this.jobs.delete(id);
		}
	}

	/** The status an event implies, so count deltas are not restated per case. */
	#statusFor(evt: NaviEvent, jobId: string): string {
		switch (evt.type) {
			case 'job.queued':
				return 'queued';
			case 'job.progress':
				return 'running';
			case 'job.completed':
				return 'succeeded';
			case 'job.failed':
				return 'failed';
			case 'job.cancelled':
				return 'cancelled';
			default:
				// Unknown event type: treat as a progress tick so nothing is double counted.
				return this.jobs.get(jobId)?.status ?? 'queued';
		}
	}

	#apply(evt: NaviEvent): void {
		const prev = this.jobs.get(evt.jobId);
		this.#bump(prev?.status, this.#statusFor(evt, evt.jobId));
		switch (evt.type) {
			case 'job.queued': {
				this.jobs.set(evt.jobId, {
					id: evt.jobId,
					type: evt.jobType,
					status: 'queued',
					priority: 5,
					progress: 0,
					stage: null,
					error: null,
					attempts: 0,
					maxAttempts: 3,
					trackId: evt.trackId,
					createdAt: evt.ts,
					finishedAt: null,
				});
				break;
			}
			case 'job.progress': {
				// Unknown job (missed the queued event during a reconnect)?
				// Create it from the event instead of silently dropping progress.
				this.jobs.set(evt.jobId, {
					...(prev ?? {
						id: evt.jobId,
						type: evt.jobType,
						priority: 5,
						error: null,
						attempts: 1,
						maxAttempts: 3,
						trackId: evt.trackId,
						createdAt: evt.ts,
						finishedAt: null,
					}),
					status: 'running',
					progress: evt.progress,
					stage: evt.stage,
				});
				break;
			}
			case 'job.completed': {
				this.jobs.set(evt.jobId, {
					...(prev ?? {
						id: evt.jobId,
						type: evt.jobType,
						priority: 5,
						error: null,
						attempts: 1,
						maxAttempts: 3,
						trackId: evt.trackId,
						createdAt: evt.ts,
					}),
					status: 'succeeded',
					progress: 100,
					stage: 'done',
					finishedAt: evt.ts,
				});
				this.#onTerminal?.();
				break;
			}
			case 'job.failed': {
				this.jobs.set(evt.jobId, {
					...(prev ?? {
						id: evt.jobId,
						type: evt.jobType,
						priority: 5,
						progress: 0,
						stage: null,
						error: null,
						attempts: 1,
						maxAttempts: 3,
						trackId: evt.trackId,
						createdAt: evt.ts,
						finishedAt: null,
					}),
					status: evt.willRetry ? 'failed' : 'dead',
					error: evt.error,
					finishedAt: evt.willRetry ? (prev?.finishedAt ?? null) : evt.ts,
				});
				this.#onTerminal?.();
				break;
			}
			case 'job.cancelled': {
				this.jobs.set(evt.jobId, {
					...(prev ?? {
						id: evt.jobId,
						type: evt.jobType,
						priority: 5,
						progress: 0,
						stage: null,
						error: null,
						attempts: 0,
						maxAttempts: 3,
						trackId: null,
						createdAt: evt.ts,
					}),
					status: 'cancelled',
					finishedAt: evt.ts,
				});
				break;
			}
		}
	}

	/**
	 * Newest first, 30 rows. That is the render window, and it is deliberately not
	 * the count — the totals come from `jobCounts`, counted over the whole table.
	 */
	get recentJobs(): JobDTO[] {
		return [...this.jobs.values()]
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, 30);
	}

	/** False until the server has supplied real totals, so a seed cannot overwrite them. */
	get hasAuthoritativeCounts(): boolean {
		return this.#countAuthoritative;
	}

	/**
	 * Authoritative per-status totals, seeded once from the server and then kept
	 * live by delta on every SSE event.
	 *
	 * Separate from `jobs` on purpose: `jobs` is a 30-row window and cannot know
	 * about work queued before the page loaded. Anything shown as a total must come
	 * from here — counting the window is what produced "Active 30" meaning "30 of
	 * the 30 rows I was handed".
	 */
	/**
	 * MUST be $state. As a plain field the page's $derived read the zero default
	 * once and the fetch assignment below triggered no invalidation, so every badge
	 * stayed at 0 forever — while the API was returning correct totals all along.
	 * `jobs` is a SvelteMap and `connected` is $state; this was the odd one out.
	 */
	#counts = $state<JobCounts>({ total: 0, active: 0, byStatus: {} });

	get jobCounts(): JobCounts {
		return this.#counts;
	}

	set jobCounts(next: JobCounts) {
		this.#counts = { total: next.total, active: next.active, byStatus: { ...next.byStatus } };
		this.#countAuthoritative = true;
	}

	#countAuthoritative = $state(false);

	/**
	 * Move the totals when a job changes status, so the badges track a draining
	 * queue in real time instead of going stale until the next fetch.
	 *
	 * `#countAuthoritative` guards the seed: before the server answers, counts are
	 * unknown and a delta would compound a wrong number, so events are ignored
	 * until real totals arrive.
	 */
	#bump(from: string | undefined, to: string): void {
		if (!this.#countAuthoritative) return;
		const byStatus = { ...this.#counts.byStatus };
		// No previous status means this job was never seen: a genuinely NEW row, so
		// `total` has to grow. Without that the "All" badge sat frozen while jobs were
		// being created, which reads as "nothing is happening".
		const isNew = from === undefined;
		if (from) byStatus[from] = Math.max(0, (byStatus[from] ?? 0) - 1);
		byStatus[to] = (byStatus[to] ?? 0) + 1;
		this.#counts = {
			total: this.#counts.total + (isNew ? 1 : 0),
			active: (byStatus['queued'] ?? 0) + (byStatus['running'] ?? 0),
			byStatus,
		};
	}

	get activeCount(): number {
		return [...this.jobs.values()].filter(
			(j) => j.status === 'queued' || j.status === 'running',
		).length;
	}
}

export const live = new LiveEventClient();
export { LiveEventClient };
