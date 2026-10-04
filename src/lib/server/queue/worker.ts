import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { jobs } from '$lib/server/db/schema';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';
import { ensureMigrated } from '$lib/server/db';
import { purgeStaleTemp } from '$lib/server/library/files';
import { setJobWakeupHandler } from '$lib/server/pg-events';
import { getSettings } from '$lib/server/settings';
import {
	claimNextJob,
	completeJob,
	failJob,
	recoverOrphanedJobs,
	updateProgress,
	type JobRow,
} from './jobs';
import { runJob } from './handlers';

/**
 * In-process job worker (ADR-0001: Node monolith, ADR-0002: Postgres queue).
 *
 * Wakeup paths:
 *   - NOTIFY on `navi_jobs` (instant, no polling latency)
 *   - 10s safety-net poll (missed notifies, restarted DBs, clock drift)
 *
 * Claims serialize through `FOR UPDATE SKIP LOCKED`, so this worker and any
 * future external engine can coexist safely. Cancellation: the API sets
 * `status='cancelled'`; a watcher aborts the in-flight AbortController.
 * SIGTERM: stop claiming, let in-flight jobs finish (30s grace), then exit.
 */

const log = logger;

interface ActiveJob {
	jobId: string;
	controller: AbortController;
}

const globalForWorker = globalThis as unknown as {
	naviWorkerStarted?: boolean;
	naviWorkerStop?: () => Promise<void>;
};

export function ensureWorkerStarted(): void {
	if (globalForWorker.naviWorkerStarted) return;
	globalForWorker.naviWorkerStarted = true;

	void (async () => {
		try {
			await ensureMigrated();
			await recoverOrphanedJobs();
			await purgeStaleTemp();

			const active = new Set<ActiveJob>();
			let shuttingDown = false;
			let claimLoopRunning = false;

			const claimLoop = async (): Promise<void> => {
				if (claimLoopRunning || shuttingDown) return;
				claimLoopRunning = true;
				try {
					for (;;) {
						if (shuttingDown) break;
						const settings = await getSettings();
						const slots = Math.max(1, settings.concurrentDownloads);
						if (active.size >= slots) break;

						const job: JobRow | null = await claimNextJob();
						if (!job) break;

						const controller = new AbortController();
						const entry: ActiveJob = { jobId: job.id, controller };
						active.add(entry);
						log.info('job started', {
							jobId: job.id,
							jobType: job.type,
							attempt: job.attempts,
						});

						void executeJob(job, controller)
							.catch((err: unknown) => {
								if (controller.signal.aborted) {
									log.warn('job aborted by cancellation', { jobId: job.id });
									return failJob(job, new Error('cancelled'), false);
								}
								log.error('job execution error', {
									jobId: job.id,
									error: String(err),
								});
								return failJob(job, err, true);
							})
							.finally(() => {
								active.delete(entry);
								void claimLoop();
							});

						if (active.size >= slots) break;
					}
				} catch (err) {
					log.error('claim loop error', { error: String(err) });
				} finally {
					claimLoopRunning = false;
				}
			};

			async function executeJob(job: JobRow, controller: AbortController): Promise<void> {
				const signal = controller.signal;
				// Cancellation watcher — checks DB status every 3s while running.
				const watcher = setInterval(() => {
					void db
						.select({ status: jobs.status })
						.from(jobs)
						.where(eq(jobs.id, job.id))
						.limit(1)
						.then((rows) => {
							if (rows[0]?.status === 'cancelled') controller.abort();
						})
						.catch(() => undefined);
				}, 3000);
				watcher.unref?.();

				try {
					const result = await runJob(job, {
						signal,
						report: (progress, stage) =>
							updateProgress(job.id, job.type, job.trackId, progress, stage),
					});
					await completeJob(job.id, job.type, job.trackId, result);
					log.info('job completed', { jobId: job.id, jobType: job.type });
				} finally {
					clearInterval(watcher);
				}
			}

			await setJobWakeupHandler(() => void claimLoop());
			const poller = setInterval(() => void claimLoop(), 10_000);
			poller.unref?.();
			void claimLoop();

			// Periodic maintenance sweeps (Phase 2): lyrics backfill + quality
			// upgrades. Both are rate-limited by the jobs table itself.
			const lyricsSweep = setInterval(() => void lyricsBackfillSweep(), 5 * 60_000);
			lyricsSweep.unref?.();
			const upgradeSweep = setInterval(() => void qualityUpgradeSweep(), 60 * 60_000);
			upgradeSweep.unref?.();
			void lyricsBackfillSweep();
			void qualityUpgradeSweep();

			globalForWorker.naviWorkerStop = async () => {
				shuttingDown = true;
				const deadline = Date.now() + 30_000;
				while (active.size > 0 && Date.now() < deadline) {
					log.info('graceful shutdown: waiting for in-flight jobs', {
						remaining: active.size,
					});
					await new Promise((r) => setTimeout(r, 1000));
				}
			};

			/* ── maintenance sweeps ─────────────────────────────────────────────────── */

			async function lyricsBackfillSweep(): Promise<void> {
				try {
					const { listLyricsBackfillCandidates } = await import('$lib/server/db/tracks');
					const { enqueueJob } = await import('./jobs');
					const candidates = await listLyricsBackfillCandidates(5);
					for (const track of candidates) {
						await enqueueJob({
							type: 'lyrics',
							payload: { trackId: track.id },
							trackId: track.id,
						});
						log.info('lyrics backfill enqueued', {
							trackId: track.id,
							title: track.title,
						});
					}
				} catch (err) {
					log.debug('lyrics backfill sweep skipped', { error: String(err) });
				}
			}

			/**
			 * Quality upgrade sweep: periodically ask each provider whether a better
			 * stream now exists for tracks below the 24-bit ceiling. On a strictly
			 * better offer, enqueue an upgrade download (which refetches lyrics after).
			 * "If the lyrics API is down, keep the same" — the lyrics handler preserves
			 * existing sidecars on failure.
			 */
			async function qualityUpgradeSweep(): Promise<void> {
				try {
					const { listUpgradeCandidates } = await import('$lib/server/db/tracks');
					const { providers } = await import('$lib/server/providers/registry');
					const { qualityRank } = await import('$lib/shared/quality');
					const { enqueueJob } = await import('./jobs');
					const { and, eq, inArray, gte } = await import('drizzle-orm');
					const { jobs } = await import('$lib/server/db/schema');
					const settings = await getSettings();

					for (const provider of providers) {
						const candidates = await listUpgradeCandidates(provider.id, 10);
						for (const track of candidates) {
							if (!track.providerTrackId) continue;
							// Skip tracks with a recent/active download attempt.
							const active = await db
								.select({ id: jobs.id })
								.from(jobs)
								.where(
									and(
										eq(jobs.trackId, track.id),
										eq(jobs.type, 'download'),
										inArray(jobs.status, ['queued', 'running']),
									),
								)
								.limit(1);
							if (active.length > 0) continue;
							const recent = await db
								.select({ id: jobs.id })
								.from(jobs)
								.where(
									and(
										eq(jobs.trackId, track.id),
										eq(jobs.type, 'download'),
										gte(
											jobs.createdAt,
											new Date(Date.now() - 24 * 3600 * 1000),
										),
									),
								)
								.limit(1);
							if (recent.length > 0) continue;

							const meta = {
								provider: track.provider,
								providerTrackId: track.providerTrackId,
								title: track.title,
								artist: track.artist,
								album: track.album,
								albumArtist: track.artist,
								isrc: track.isrc,
								trackNumber: null,
								discNumber: null,
								durationSec: track.durationSec,
								year: track.year,
								genre: track.genre,
								coverUrl: null,
								sourceUrl: track.sourceUrl,
								streamToken: null,
							};
							const existingRank = qualityRank({
								format: track.format,
								bitrateKbps: track.bitrateKbps,
								bitDepth: track.bitDepth,
								isLossless: track.isLossless,
							});
							if (existingRank >= 4) continue; // ceiling reached

							try {
								const resolution = await provider.resolve(meta, {
									preferLossless: settings.preferLossless,
									minBitrateKbps: settings.minBitrateKbps,
									allowLowerFallback: settings.allowLowerFallback,
								});
								const incomingRank = qualityRank({
									format: resolution.format,
									bitrateKbps: resolution.claimedBitrateKbps,
									bitDepth: resolution.claimedLossless ? 24 : null,
									isLossless: resolution.claimedLossless,
								});
								if (incomingRank <= existingRank) continue;

								await enqueueJob({
									type: 'download',
									payload: {
										url: meta.sourceUrl ?? meta.providerTrackId,
										provider: provider.id,
										upgradeForTrackId: track.id,
									},
									trackId: track.id,
								});
								log.info('upgrade enqueued', {
									trackId: track.id,
									title: track.title,
									from: existingRank,
									to: incomingRank,
								});
							} catch (err) {
								// No rights/availability right now — log quietly and skip the
								// remaining candidates this sweep (next sweep retries).
								log.debug('upgrade check unavailable', {
									trackId: track.id,
									error: String(err),
								});
								break;
							}
						}
					}
				} catch (err) {
					log.debug('upgrade sweep skipped', { error: String(err) });
				}
			}

			process.on('SIGTERM', () => {
				void (async () => {
					log.info('SIGTERM received — draining worker');
					await globalForWorker.naviWorkerStop?.();
					process.exit(0);
				})();
			});

			log.info('worker started', {
				concurrent: (await getSettings()).concurrentDownloads,
				tmpDir: env.MUSIC_TMP_DIR,
			});
		} catch (err) {
			globalForWorker.naviWorkerStarted = false;
			log.error('worker failed to start', { error: String(err) });
		}
	})();
}
