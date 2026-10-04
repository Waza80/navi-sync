import { isNaviEvent, type JobDTO, type NaviEvent } from '$lib/shared/types';

/**
 * Live event client (SSE). Backed by Postgres NOTIFY → /api/events — there is
 * no polling anywhere in the UI (spec: real-time without setInterval).
 *
 * Svelte 5 runes: `Map`/`Set` in `$state` are deeply reactive proxies.
 */
class LiveEventClient {
	jobs = $state<Map<string, JobDTO>>(new Map());
	connected = $state(false);
	#source: EventSource | null = null;
	#onTerminal: (() => void) | null = null;

	/** Idempotent. Call once from the dashboard page (browser only). */
	start(onTerminal?: () => void): void {
		if (typeof window === 'undefined' || this.#source) return;
		this.#onTerminal = onTerminal ?? null;
		const es = new EventSource('/api/events');
		this.#source = es;
		es.onopen = () => {
			this.connected = true;
		};
		es.onerror = () => {
			this.connected = false; // EventSource auto-reconnects
		};
		es.addEventListener('hello', () => {
			this.connected = true;
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

	/**
	 * Seed/replace with the authoritative server snapshot. Overwrites (not
	 * just adds) so missed SSE events during reconnects can never leave a
	 * stale entry behind.
	 */
	hydrate(jobs: JobDTO[]): void {
		for (const j of jobs) this.jobs.set(j.id, j);
	}

	/** Drop entries absent from the authoritative snapshot (post-clear). */
	pruneNotIn(jobs: JobDTO[]): void {
		const ids = new Set(jobs.map((j) => j.id));
		for (const id of [...this.jobs.keys()]) {
			if (!ids.has(id)) this.jobs.delete(id);
		}
	}

	#apply(evt: NaviEvent): void {
		const current = this.jobs.get(evt.jobId);
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
				if (current) {
					current.progress = evt.progress;
					current.stage = evt.stage;
					current.status = 'running';
				}
				break;
			}
			case 'job.completed': {
				if (current) {
					current.status = 'succeeded';
					current.progress = 100;
					current.stage = 'done';
					current.finishedAt = evt.ts;
				}
				this.#onTerminal?.();
				break;
			}
			case 'job.failed': {
				if (current) {
					current.status = evt.willRetry ? 'failed' : 'dead';
					current.error = evt.error;
					if (!evt.willRetry) current.finishedAt = evt.ts;
				}
				this.#onTerminal?.();
				break;
			}
			case 'job.cancelled': {
				if (current) {
					current.status = 'cancelled';
					current.finishedAt = evt.ts;
				}
				break;
			}
		}
	}

	/** Newest first, capped for render performance. */
	get recentJobs(): JobDTO[] {
		return [...this.jobs.values()]
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(0, 30);
	}

	get activeCount(): number {
		return [...this.jobs.values()].filter(
			(j) => j.status === 'queued' || j.status === 'running',
		).length;
	}
}

export const live = new LiveEventClient();
