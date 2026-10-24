import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { db, pool } from '$lib/server/db';
import { jobs, tracks } from '$lib/server/db/schema';
import type { JobStatus, JobType, NaviEvent } from '$lib/shared/types';
import { logger } from '$lib/server/logger';

const log = logger;

export interface JobRow {
	id: string;
	type: JobType;
	status: JobStatus;
	priority: number;
	payload: Record<string, unknown>;
	progress: number;
	stage: string | null;
	result: Record<string, unknown> | null;
	error: string | null;
	attempts: number;
	maxAttempts: number;
	runAfter: Date;
	startedAt: Date | null;
	finishedAt: Date | null;
	trackId: string | null;
	createdBy: string | null;
	createdAt: Date;
	updatedAt: Date;
}

/** Exponential backoff between attempts: 30s, 60s, 120s (capped at 10 min). */
export function backoffMs(attempt: number): number {
	const base = 30_000 * Math.pow(2, Math.max(0, attempt - 1));
	return Math.min(base, 600_000);
}

export async function enqueueJob(input: {
	type: JobType;
	payload: Record<string, unknown>;
	priority?: number;
	maxAttempts?: number;
	trackId?: string | null;
	createdBy?: string | null;
}): Promise<JobRow> {
	const [row] = await db
		.insert(jobs)
		.values({
			type: input.type,
			payload: input.payload,
			priority: input.priority ?? 5,
			maxAttempts: input.maxAttempts ?? 3,
			trackId: input.trackId ?? null,
			createdBy: input.createdBy ?? null,
		})
		.returning();
	const job = row as JobRow;
	await notifyJobs({ id: job.id, type: job.type, event: 'job.queued', trackId: job.trackId });
	log.info('job enqueued', { jobId: job.id, jobType: job.type });
	return job;
}

/**
 * Enqueue many jobs in ONE statement.
 *
 * `enqueueJob` in a loop is the wrong shape for a bulk action: each call is an
 * INSERT plus a `pg_notify`, so 500 of them is 1000 sequential round trips while
 * the HTTP request is held open and the button sits on "Queueing…". It reads as
 * an inert control, and it competes with the worker for the same 10-connection
 * pool while doing it.
 *
 * Chunked so one statement never grows unbounded, and it returns the number
 * actually written so the caller reports what happened rather than what it
 * intended.
 */
export async function enqueueJobsBulk(
	inputs: Array<{
		type: JobType;
		payload: Record<string, unknown>;
		priority?: number;
		maxAttempts?: number;
		trackId?: string | null;
		createdBy?: string | null;
	}>,
): Promise<number> {
	if (inputs.length === 0) return 0;
	const CHUNK = 200;
	let written = 0;
	for (let i = 0; i < inputs.length; i += CHUNK) {
		const chunk = inputs.slice(i, i + CHUNK);
		const rows = await db
			.insert(jobs)
			.values(
				chunk.map((input) => ({
					type: input.type,
					payload: input.payload,
					priority: input.priority ?? 5,
					maxAttempts: input.maxAttempts ?? 3,
					trackId: input.trackId ?? null,
					createdBy: input.createdBy ?? null,
				})),
			)
			.returning({ id: jobs.id });
		written += rows.length;
	}
	// One notification for the batch, not one per row: the worker's claim loop is
	// woken by the poller every 10s regardless, so per-row NOTIFY is pure overhead.
	await notifyJobs({ ids: 'bulk', count: written });
	log.info('jobs enqueued in bulk', { count: written });
	return written;
}

/**
 * Enqueue a fan-out of download jobs without duplicating work.
 *
 * A fan-out used to be `for (id of ids) await enqueueJob(...)`, which meant:
 *  - a playlist that contains the same track twice queued two jobs for it, and
 *    whichever finished second could not recognise the first file and created a
 *    duplicate row;
 *  - pressing "download album" and then clicking the album's only track (or
 *    re-pasting the link) queued a second job for a track that was already
 *    queued, running, or sitting on disk.
 *
 * Three filters, in order of cheapness: the request's own duplicates, downloads
 * already queued/running, and tracks that already have a file. The last one is
 * what makes re-pasting a 490-track playlist a no-op instead of 490 jobs that
 * each hard-stop in the worker.
 */
export async function enqueueDownloadJobs(
	inputs: Array<{
		url: string;
		provider: string;
		createdBy?: string | null;
		priority?: number;
	}>,
): Promise<{ enqueued: number; skipped: number }> {
	const unique = new Map<string, (typeof inputs)[number]>();
	for (const input of inputs) {
		if (typeof input.url === 'string' && input.url.trim() !== '' && !unique.has(input.url)) {
			unique.set(input.url, input);
		}
	}
	if (unique.size === 0) return { enqueued: 0, skipped: 0 };

	const active = await db
		.select({ payload: jobs.payload })
		.from(jobs)
		.where(and(eq(jobs.type, 'download'), inArray(jobs.status, ['queued', 'running'])));
	const activeUrls = new Set(
		active
			.map((r) => (r.payload as Record<string, unknown> | null)?.['url'])
			.filter((u): u is string => typeof u === 'string'),
	);

	// Provider-native ids from the page URLs, so a re-paste can see what is
	// already filed. `canonicalTrackId` is provider-aware and returns a URL for
	// providers that do not store bare ids, hence the regex here.
	const candidates = [...unique.values()].filter(
		(i) => !activeUrls.has(i.url) && !activeUrls.has(i.url.replace(/\/+$/, '')),
	);
	const byProvider = new Map<string, Map<string, string>>();
	for (const c of candidates) {
		const runs = c.url.match(/\d{4,15}/g);
		const nativeId = runs && runs.length > 0 ? runs[runs.length - 1] : null;
		if (!nativeId) continue;
		const bucket = byProvider.get(c.provider) ?? new Map<string, string>();
		bucket.set(nativeId, c.url);
		byProvider.set(c.provider, bucket);
	}
	const filedUrls = new Set<string>();
	for (const [provider, bucket] of byProvider) {
		const rows = await db
			.select({ providerTrackId: tracks.providerTrackId, filePath: tracks.filePath })
			.from(tracks)
			.where(
				and(
					eq(tracks.provider, provider),
					inArray(tracks.providerTrackId, [...bucket.keys()]),
					isNotNull(tracks.filePath),
				),
			);
		for (const row of rows) {
			const url = row.providerTrackId ? bucket.get(row.providerTrackId) : null;
			if (url) filedUrls.add(url);
		}
	}

	const fresh = candidates.filter((c) => !filedUrls.has(c.url));
	const enqueued = await enqueueJobsBulk(
		fresh.map((input) => ({
			type: 'download' as const,
			payload: { url: input.url, provider: input.provider },
			createdBy: input.createdBy ?? null,
			priority: input.priority ?? 5,
		})),
	);
	return { enqueued, skipped: unique.size - enqueued };
}

/** Wake the worker via NOTIFY (fire-and-forget, non-fatal on failure). */
async function notifyJobs(meta: Record<string, unknown>): Promise<void> {
	try {
		await pool.query("SELECT pg_notify('navi_jobs', $1)", [JSON.stringify(meta)]);
	} catch (err) {
		log.warn('navi_jobs notify failed (poller will recover)', { error: String(err) });
	}
}

export async function emitEvent(evt: NaviEvent): Promise<void> {
	try {
		await pool.query("SELECT pg_notify('navi_events', $1)", [JSON.stringify(evt)]);
	} catch (err) {
		log.warn('navi_events notify failed', { error: String(err), evtType: evt.type });
	}
}

/**
 * Claim the next runnable job. `FOR UPDATE SKIP LOCKED` makes this safe for
 * multiple claimants — including, later, an external engine process.
 */
export async function claimNextJob(): Promise<JobRow | null> {
	const result = await pool.query(
		`UPDATE jobs SET
				status = 'running',
				started_at = COALESCE(started_at, now()),
				updated_at = now(),
				attempts = attempts + 1
			WHERE id = (
				SELECT id FROM jobs
				WHERE status = 'queued' AND run_after <= now()
				ORDER BY priority DESC, created_at ASC
				FOR UPDATE SKIP LOCKED
				LIMIT 1
			)
			RETURNING *`,
	);
	const row = result.rows[0] as Record<string, unknown> | undefined;
	if (!row) return null;
	// Raw pg rows are snake_case — map to the camelCase JobRow contract.
	// (A plain `as JobRow` left `maxAttempts` undefined, which silently
	// dead-lettered every first failure: `1 < undefined` === false.)
	const job = {
		id: row['id'],
		type: row['type'],
		status: row['status'],
		priority: row['priority'],
		payload: row['payload'],
		progress: row['progress'],
		stage: row['stage'],
		result: row['result'],
		error: row['error'],
		attempts: row['attempts'],
		maxAttempts: row['max_attempts'],
		runAfter: row['run_after'],
		startedAt: row['started_at'],
		finishedAt: row['finished_at'],
		trackId: row['track_id'],
		createdBy: row['created_by'],
		createdAt: row['created_at'],
		updatedAt: row['updated_at'],
	} as unknown as JobRow;
	return job;
}

/**
 * Debounced post-download scan: keeps Navidrome indexed without spamming one
 * scan job per finished download.
 *
 * Three gates, each learned from a real complaint:
 *  - `autoScan` off means the user wants to scan on their own schedule. A
 *    400-track playlist draining over hours used to fire the debounce again and
 *    again, each scan holding a worker slot and talking to Navidrome;
 *  - a scan already queued/running is skipped — Navidrome picks up every file
 *    present when it runs;
 *  - a scan that RAN in the last 10 minutes is skipped too. The queued/running
 *    check alone re-armed the moment the scan job finished, so a long import
 *    produced a scan every few minutes for its entire duration.
 */
export async function ensurePostDownloadScan(): Promise<void> {
	const { getSettings } = await import('$lib/server/settings');
	const settings = await getSettings();
	if (!settings.autoScan) {
		log.debug('post-download scan skipped (autoScan disabled)');
		return;
	}
	const active = await db
		.select({ id: jobs.id })
		.from(jobs)
		.where(and(eq(jobs.type, 'navidrome_scan'), inArray(jobs.status, ['queued', 'running'])))
		.limit(1);
	if (active.length > 0) {
		log.debug('post-download scan skipped (scan already pending)');
		return;
	}
	const recent = await db
		.select({ id: jobs.id })
		.from(jobs)
		.where(
			and(
				eq(jobs.type, 'navidrome_scan'),
				gte(jobs.createdAt, new Date(Date.now() - 10 * 60_000)),
			),
		)
		.limit(1);
	if (recent.length > 0) {
		log.debug('post-download scan skipped (a scan ran recently)');
		return;
	}
	await enqueueJob({ type: 'navidrome_scan', payload: { reason: 'post-download' }, priority: 2 });
}

export async function updateProgress(
	jobId: string,
	jobType: JobType,
	trackId: string | null,
	progress: number,
	stage: string,
): Promise<void> {
	const clamped = Math.max(0, Math.min(100, Math.round(progress)));
	await db
		.update(jobs)
		.set({ progress: clamped, stage, updatedAt: new Date() })
		.where(eq(jobs.id, jobId));
	await emitEvent({
		type: 'job.progress',
		jobId,
		jobType,
		trackId,
		progress: clamped,
		stage,
		ts: new Date().toISOString(),
	});
}

export async function completeJob(
	jobId: string,
	jobType: JobType,
	trackId: string | null,
	result: Record<string, unknown> | null,
): Promise<void> {
	await db
		.update(jobs)
		.set({
			status: 'succeeded',
			progress: 100,
			stage: 'done',
			result,
			error: null,
			finishedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(jobs.id, jobId));
	await emitEvent({
		type: 'job.completed',
		jobId,
		jobType,
		trackId,
		result,
		ts: new Date().toISOString(),
	});
}

/**
 * Handle a job failure: retry with backoff until maxAttempts, then dead-letter.
 */
export async function failJob(
	job: JobRow,
	error: unknown,
	retryable = true,
): Promise<'queued' | 'dead'> {
	const message = error instanceof Error ? error.message : String(error);
	const stack = error instanceof Error ? (error.stack ?? '').slice(0, 800) : undefined;
	if (stack) log.debug('job failure stack', { jobId: job.id, stack });
	const willRetry = retryable && job.attempts < job.maxAttempts;
	if (willRetry) {
		const runAfter = new Date(Date.now() + backoffMs(job.attempts));
		await db
			.update(jobs)
			.set({ status: 'queued', error: message, runAfter, updatedAt: new Date() })
			.where(eq(jobs.id, job.id));
		await emitEvent({
			type: 'job.failed',
			jobId: job.id,
			jobType: job.type,
			trackId: job.trackId,
			error: message,
			willRetry: true,
			ts: new Date().toISOString(),
		});
		await notifyJobs({
			id: job.id,
			event: 'retry_scheduled',
			runAfter: runAfter.toISOString(),
		});
		log.warn('job failed, retry scheduled', {
			jobId: job.id,
			attempt: job.attempts,
			maxAttempts: job.maxAttempts,
			nextRun: runAfter.toISOString(),
			error: message,
		});
		return 'queued';
	} else {
		await db
			.update(jobs)
			.set({ status: 'dead', error: message, finishedAt: new Date(), updatedAt: new Date() })
			.where(eq(jobs.id, job.id));
		await emitEvent({
			type: 'job.failed',
			jobId: job.id,
			jobType: job.type,
			trackId: job.trackId,
			error: message,
			willRetry: false,
			ts: new Date().toISOString(),
		});
		log.error('job dead-lettered', { jobId: job.id, jobType: job.type, error: message });
		return 'dead';
	}
}

/** User-initiated cancel: queued → cancelled immediately; running is aborted by the worker. */
export async function cancelJob(jobId: string): Promise<JobStatus | 'cancelling' | null> {
	const rows = await db
		.update(jobs)
		.set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
		.where(and(inArray(jobs.status, ['queued']), eq(jobs.id, jobId)))
		.returning({ status: jobs.status });
	if (rows.length > 0) {
		await emitEvent({
			type: 'job.cancelled',
			jobId,
			jobType: 'download',
			ts: new Date().toISOString(),
		});
		return 'cancelled';
	}
	const running = await db
		.select({ status: jobs.status, type: jobs.type })
		.from(jobs)
		.where(and(inArray(jobs.status, ['running']), eq(jobs.id, jobId)))
		.limit(1);
	if (running.length > 0) {
		// Worker's cancellation watcher picks this up and aborts between steps.
		await db.update(jobs).set({ updatedAt: new Date() }).where(eq(jobs.id, jobId));
		await db.execute(
			sql`UPDATE jobs SET status = 'cancelled' WHERE id = ${jobId} AND status = 'running' AND progress = 0`,
		);
		return 'cancelling';
	}
	return null;
}

/** Manual retry: reset a dead/failed job back into the queue. */
export async function retryJob(jobId: string): Promise<JobRow | null> {
	const rows = await db
		.update(jobs)
		.set({
			status: 'queued',
			attempts: 0,
			error: null,
			progress: 0,
			stage: null,
			runAfter: new Date(),
			startedAt: null,
			finishedAt: null,
			updatedAt: new Date(),
		})
		.where(and(inArray(jobs.status, ['dead', 'failed', 'cancelled']), eq(jobs.id, jobId)))
		.returning();
	const row = rows[0] as JobRow | undefined;
	if (row) await notifyJobs({ id: row.id, event: 'job.queued', type: row.type });
	return row ?? null;
}

/** On boot: crash recovery — anything stuck in `running` goes back to `queued`. */
export async function recoverOrphanedJobs(): Promise<number> {
	const rows = await db
		.update(jobs)
		.set({ status: 'queued', runAfter: new Date(), updatedAt: new Date() })
		.where(eq(jobs.status, 'running'))
		.returning({ id: jobs.id });
	if (rows.length > 0) {
		log.warn('recovered orphaned jobs from previous run', { count: rows.length });
		await notifyJobs({ event: 'recovered', count: rows.length });
	}
	return rows.length;
}

/**
 * Most recent jobs, optionally filtered by status.
 *
 * The window is the RETURNED list and nothing more. It is deliberately not a
 * count: a caller that wants to know how much work exists must ask
 * `jobCounts()`, because a 30-row window cannot tell "30 exist" from "30 were
 * shown" — the exact confusion behind the dashboard showing "Active 30" while the
 * queue held hundreds.
 */
export async function listJobs(limit = 30, statuses?: readonly JobStatus[]): Promise<JobRow[]> {
	const q = statuses?.length
		? db
				.select()
				.from(jobs)
				.where(inArray(jobs.status, [...statuses]))
		: db.select().from(jobs);
	return (await q
		.orderBy(desc(jobs.createdAt))
		.limit(Math.min(500, Math.max(1, limit)))) as JobRow[];
}

/**
 * Real per-status job totals, counted over the whole table.
 *
 * `active` is queued + running — what the queue panel means by "active" — and it
 * is deliberately a separate query from the listing so a truncated window can
 * never masquerade as the truth.
 */
export async function jobCounts(): Promise<{
	total: number;
	active: number;
	byStatus: Record<string, number>;
	/**
	 * When a job was last created.
	 *
	 * This is the number that would have shown the app was dead. It was down for
	 * ten days with a queue that read "0 active" the whole time — indistinguishable
	 * from a healthy idle system — because nothing anywhere looked at WHEN the last
	 * work happened, only at how much was outstanding. An empty queue and a dead
	 * worker produce identical readings.
	 */
	lastActivityAt: string | null;
}> {
	const rows = await db
		.select({ status: jobs.status, n: sql<number>`count(*)::int` })
		.from(jobs)
		.groupBy(jobs.status);
	const byStatus: Record<string, number> = {};
	let total = 0;
	for (const r of rows) {
		byStatus[r.status] = Number(r.n);
		total += Number(r.n);
	}
	const [newest] = await db.select({ at: sql<Date | null>`max(${jobs.createdAt})` }).from(jobs);
	// `active` means queued + running and nothing else, so it agrees with what the
	// dashboard's "Active" tab shows. It previously also counted `failed`, which is
	// a retryable terminal-ish state — so any consumer of counts.active disagreed
	// with the filter the user was looking at.
	const active = (byStatus['queued'] ?? 0) + (byStatus['running'] ?? 0);
	return {
		total,
		active,
		byStatus,
		lastActivityAt: newest?.at ? new Date(newest.at).toISOString() : null,
	};
}

export async function getJob(jobId: string): Promise<JobRow | null> {
	const rows = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
	return (rows[0] as JobRow | undefined) ?? null;
}

export async function nextRunnableCount(): Promise<number> {
	const [{ count }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(jobs)
		.where(and(eq(jobs.status, 'queued'), lte(jobs.runAfter, new Date())));
	return count;
}

/**
 * Track ids with an unfinished job of a given type.
 *
 * A reindex sweep calls the enqueue endpoint in a loop, and a row's
 * `metadata_refreshed_at` is only stamped once its job actually RUNS — so while
 * the queue is still draining every row still looks "never refreshed" and the
 * next call enqueues it again. With a batch loop that is a runaway: one sweep
 * enqueued 4000 jobs for 686 tracks before this was noticed.
 *
 * Deduplicating against live work rather than against timestamps is what makes
 * the sweep idempotent no matter how fast the caller loops.
 */
export async function tracksWithPendingJob(type: JobType): Promise<Set<string>> {
	const rows = await db
		.select({ trackId: jobs.trackId })
		.from(jobs)
		.where(
			and(
				eq(jobs.type, type),
				inArray(jobs.status, ['queued', 'running']),
				isNotNull(jobs.trackId),
			),
		);
	return new Set(rows.map((r) => r.trackId).filter((v): v is string => typeof v === 'string'));
}

/**
 * Cancel outstanding jobs for a track, so deleting a row does not leave them to
 * fail on a row that no longer exists.
 *
 * Deleting a track while its jobs are queued produced "Track not found: <uuid>"
 * dead jobs — 25 of them in the last few hours, all of it pure noise from the
 * delete itself. Those jobs can only ever fail, so they are cancelled rather than
 * left to burn their retries.
 */
export async function cancelJobsForTrack(trackId: string): Promise<number> {
	const rows = await db
		.update(jobs)
		.set({
			status: 'cancelled',
			finishedAt: new Date(),
			updatedAt: new Date(),
			error: 'cancelled: track deleted',
		})
		.where(and(eq(jobs.trackId, trackId), inArray(jobs.status, ['queued', 'running'])))
		.returning({ id: jobs.id });
	return rows.length;
}

export { asc };

/** Bulk-clear unimportant queue history: succeeded, cancelled and failed
 * (retryable) jobs. Dead-lettered jobs are kept for manual review. */
export async function clearCompletedJobs(): Promise<number> {
	// `dead` is a TERMINAL state, so it belongs here.
	//
	// It did not, which made "Clear finished" look broken: the table was 1241 dead
	// jobs out of 1246, and the delete matched the other five. The button reported a
	// successful clear of nothing while the thing the user was looking at stayed put.
	// Dead jobs are kept "for review" only while review is possible; 1241 identical
	// dead-letter rows from one runaway sweep is noise, not a review queue.
	const rows = await db
		.delete(jobs)
		.where(inArray(jobs.status, ['succeeded', 'cancelled', 'failed', 'dead']))
		.returning({ id: jobs.id });
	if (rows.length > 0) log.info('cleared finished jobs', { count: rows.length });
	return rows.length;
}
