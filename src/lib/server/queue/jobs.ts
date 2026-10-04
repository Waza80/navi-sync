import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { db, pool } from '$lib/server/db';
import { jobs } from '$lib/server/db/schema';
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

/** Debounced post-download scan: keeps Navidrome indexed without spamming
 * one scan job per finished download. Skips when a scan is already queued or
 * running — Navidrome picks up every file present when it runs.
 */
export async function ensurePostDownloadScan(): Promise<void> {
	const active = await db
		.select({ id: jobs.id })
		.from(jobs)
		.where(and(eq(jobs.type, 'navidrome_scan'), inArray(jobs.status, ['queued', 'running'])))
		.limit(1);
	if (active.length > 0) {
		log.debug('post-download scan skipped (scan already pending)');
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

export async function listJobs(limit = 30): Promise<JobRow[]> {
	return (await db
		.select()
		.from(jobs)
		.orderBy(desc(jobs.createdAt))
		.limit(Math.min(100, Math.max(1, limit)))) as JobRow[];
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

export { asc };

/** Bulk-clear unimportant queue history: succeeded, cancelled and failed
 * (retryable) jobs. Dead-lettered jobs are kept for manual review. */
export async function clearCompletedJobs(): Promise<number> {
	const rows = await db
		.delete(jobs)
		.where(inArray(jobs.status, ['succeeded', 'cancelled', 'failed']))
		.returning({ id: jobs.id });
	if (rows.length > 0) log.info('cleared completed jobs', { count: rows.length });
	return rows.length;
}
