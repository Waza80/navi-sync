import { json, unauthorizedResponse } from '$lib/server/api';
import { sql, desc, isNotNull } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { jobs, tracks } from '$lib/server/db/schema';
import { jobCounts } from '$lib/server/queue/jobs';
import { describeSignature, errorSignature } from '$lib/server/queue/errors';
import { trackStats } from '$lib/server/db/tracks';
import { getSettings } from '$lib/server/settings';
import { APP_VERSION } from '$lib/version';
import type { RequestHandler } from './$types';

/**
 * GET /api/diagnostics — one call that answers "is anything wrong?".
 *
 * Built around the failure that was invisible for ten days: the app was down,
 * the queue had been empty of activity since the day before, and nothing
 * surfaced it. `lastJobActivity` is the number that would have shown it —
 * an app with no jobs for hours is either idle or dead, and the page must be
 * able to tell those apart.
 *
 * `errorSignatures` groups dead/failed jobs by their message with the volatile
 * parts cut off, so "the same 40 jobs failed the same way" is one row rather
 * than 40. It is the fastest way to spot a systematic breakage that a single
 * job's error text hides.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return unauthorizedResponse();

	const [counts, stats, settings] = await Promise.all([jobCounts(), trackStats(), getSettings()]);

	// Newest job of any kind. Null means the queue has never run.
	const [lastJob] = await db
		.select({ createdAt: jobs.createdAt, type: jobs.type, status: jobs.status })
		.from(jobs)
		.orderBy(desc(jobs.createdAt))
		.limit(1);

	// Newest examination by the quality-upgrade engine, and how far it has got.
	const [upgrade] = await db
		.select({
			lastCheckedAt: sql<Date | null>`max(${tracks.upgradeCheckedAt})`,
			examined: sql<number>`count(${tracks.upgradeCheckedAt})::int`,
			upgradeable: sql<number>`count(*) filter (where ${tracks.upgradeCheckedAt} is not null)::int`,
		})
		.from(tracks)
		.where(isNotNull(tracks.filePath));

	// Group failures by shape, not by text. Normalising in JS rather than SQL so it
	// can be unit-tested and so the signing parameters of a provider URL are
	// redacted — a regex inside Postgres would have had to be right on the first
	// try, with no test to prove it.
	const failedRows = await db
		.select({
			type: jobs.type,
			status: jobs.status,
			error: jobs.error,
			attempts: jobs.attempts,
			createdAt: jobs.createdAt,
		})
		.from(jobs)
		.where(sql`${jobs.status} in ('dead','failed')`)
		.orderBy(desc(jobs.createdAt))
		.limit(500);

	const grouped = new Map<
		string,
		{ type: string; status: string; signature: string; n: number; newest: string }
	>();
	for (const row of failedRows) {
		const signature = errorSignature(row.error);
		const key = `${row.type}|${row.status}|${signature}`;
		const existing = grouped.get(key);
		const newest = new Date(row.createdAt).toISOString();
		if (existing) {
			existing.n += 1;
			if (newest > existing.newest) existing.newest = newest;
		} else {
			grouped.set(key, {
				type: row.type,
				status: row.status,
				signature: describeSignature(signature),
				n: 1,
				newest,
			});
		}
	}
	const errorSignatures = [...grouped.values()].sort((a, b) => b.n - a.n).slice(0, 25);

	const queueAgeMs = lastJob ? Date.now() - new Date(lastJob.createdAt).getTime() : null;

	return json({
		version: APP_VERSION,
		library: {
			total: stats.total,
			filed:
				stats.byQuality.lossy +
				stats.byQuality.cd16 +
				stats.byQuality.bit24 +
				stats.byQuality.hires,
			byQuality: stats.byQuality,
			upgradeable: stats.upgradeable,
			failed: stats.failed,
			withLyrics: stats.withLyrics,
		},
		queue: {
			...counts,
			lastJobAt: lastJob ? new Date(lastJob.createdAt).toISOString() : null,
			lastJobAgeHours:
				queueAgeMs == null ? null : Math.round((queueAgeMs / 3_600_000) * 10) / 10,
			lastJobType: lastJob?.type ?? null,
			/**
			 * The alarm. A library this size produces jobs continuously, so hours
			 * without one means the worker is not draining the queue — which is
			 * exactly the state that is indistinguishable from "all is well" if the
			 * dashboard only ever shows zero active jobs.
			 */
			stale: queueAgeMs != null && queueAgeMs > 6 * 3_600_000,
		},
		upgrades: {
			enabled: settings.autoUpgradeQuality,
			preferHiRes: settings.preferHiRes,
			preferLossless: settings.preferLossless,
			lastCheckedAt: upgrade?.lastCheckedAt
				? new Date(upgrade.lastCheckedAt).toISOString()
				: null,
			rowsExamined: upgrade?.examined ?? 0,
			candidatesRemaining: Math.max(
				0,
				(stats.upgradeable ?? 0) - (upgrade?.upgradeable ?? 0),
			),
		},
		errorSignatures,
	});
};
