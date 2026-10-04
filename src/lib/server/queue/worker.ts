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
	ensurePostDownloadScan,
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
							.catch(async (err: unknown) => {
								if (controller.signal.aborted) {
									log.warn('job aborted by cancellation', { jobId: job.id });
									return failJob(job, new Error('cancelled'), false);
								}
								log.error('job execution error', {
									jobId: job.id,
									error: String(err),
								});
								const outcome = await failJob(job, err, true);
								if (outcome === 'dead' && job.type === 'download') {
									// Failed downloads stay visible as failed track rows.
									await recordFailedDownload(job, String(err)).catch((e) =>
										log.warn('failed-track row not recorded', {
											error: String(e),
										}),
									);
								}
								return outcome;
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
					if (job.type === 'download') {
						// Keep Navidrome indexed: one debounced scan covers every
						// file landed since the last scan.
						await ensurePostDownloadScan().catch((err) =>
							log.warn('post-download scan not scheduled', { error: String(err) }),
						);
					}
				} finally {
					clearInterval(watcher);
				}
			}

			await setJobWakeupHandler(() => void claimLoop());
			const poller = setInterval(() => void claimLoop(), 10_000);
			poller.unref?.();
			void claimLoop();

			// Periodic maintenance sweeps: lyrics backfill (5m), failed-download
			// retries (30m), cross-provider quality upgrades (1h). All are
			// rate-limited by the jobs table itself.
			const lyricsSweep = setInterval(() => void lyricsBackfillSweep(), 5 * 60_000);
			lyricsSweep.unref?.();
			const retrySweep = setInterval(() => void downloadRetrySweep(), 30 * 60_000);
			retrySweep.unref?.();
			const upgradeSweep = setInterval(() => void qualityUpgradeSweep(), 60 * 60_000);
			upgradeSweep.unref?.();
			void lyricsBackfillSweep();
			void downloadRetrySweep();
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
			 * Quality upgrade sweep (CROSS-PROVIDER): for every track below the
			 * 24-bit ceiling, ask ALL configured providers (Deezer AND Monochrome
			 * AND …) for the best available version — ISRC-exact when possible.
			 * One provider up = it takes precedence; both up = best quality wins.
			 * Enqueued upgrades refetch lyrics; a downed lyrics API keeps existing
			 * sidecars (handled by the lyrics job).
			 */
			async function qualityUpgradeSweep(): Promise<void> {
				try {
					const { listUpgradeCandidates } = await import('$lib/server/db/tracks');
					const { findBestUpgrade } = await import('./upgrades');
					const { enqueueJob } = await import('./jobs');
					const candidates = await listUpgradeCandidates('*', 25);
					for (const track of candidates) {
						const upgrade = await findBestUpgrade(track).catch(() => null);
						if (!upgrade) continue;
						await enqueueJob({
							type: 'download',
							payload: {
								url: upgrade.meta.sourceUrl ?? upgrade.meta.providerTrackId,
								provider: upgrade.provider,
								upgradeForTrackId: track.id,
								meta: {
									title: upgrade.meta.title,
									artist: upgrade.meta.artist,
									album: upgrade.meta.album,
									durationSec: upgrade.meta.durationSec,
									isrc: upgrade.meta.isrc,
									coverUrl: upgrade.meta.coverUrl,
									year: upgrade.meta.year,
								},
							},
							trackId: track.id,
							priority: 6,
						});
						log.info('cross-provider upgrade enqueued', {
							trackId: track.id,
							title: track.title,
							to: upgrade.incomingRank,
							via: upgrade.provider,
						});
					}
				} catch (err) {
					log.debug('upgrade sweep skipped', { error: String(err) });
				}
			}

			/** Failed-download retry sweep: 6h cooldown per track, oldest first. */
			async function downloadRetrySweep(): Promise<void> {
				try {
					const { listFailedDownloadTracks, markDownloadStatus } =
						await import('$lib/server/db/tracks');
					const { enqueueJob } = await import('./jobs');
					const rows = await listFailedDownloadTracks(5);
					for (const row of rows) {
						await enqueueJob({
							type: 'download',
							payload: {
								url:
									row.sourceUrl ??
									`https://www.deezer.com/track/${row.providerTrackId ?? ''}`,
								provider: row.provider,
								retryForTrackId: row.id,
								meta: { title: row.title, artist: row.artist },
							},
							trackId: row.id,
						});
						await markDownloadStatus(row.id, 'pending');
						log.info('failed download requeued', { trackId: row.id, title: row.title });
					}
				} catch (err) {
					log.debug('download retry sweep skipped', { error: String(err) });
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

/** Best-effort placeholder row so failed downloads are visible + retryable. */
async function recordFailedDownload(job: JobRow, error: string): Promise<void> {
	const payload = job.payload as {
		url?: string;
		provider?: string;
		meta?: Record<string, unknown>;
	};
	const providerId = typeof payload.provider === 'string' ? payload.provider : 'unknown';
	const meta: Record<string, unknown> = payload.meta ?? {};
	let title = typeof meta['title'] === 'string' ? meta['title'] : '';
	let artist = typeof meta['artist'] === 'string' ? meta['artist'] : '';
	let album = typeof meta['album'] === 'string' ? meta['album'] : null;
	let isrc = typeof meta['isrc'] === 'string' ? meta['isrc'] : null;
	let coverUrl = typeof meta['coverUrl'] === 'string' ? meta['coverUrl'] : null;
	let year = typeof meta['year'] === 'number' ? meta['year'] : null;
	let durationSec = typeof meta['durationSec'] === 'number' ? meta['durationSec'] : null;

	// Enrich from the provider when possible (metadata API ≠ stream rights).
	if (providerId !== 'unknown') {
		try {
			const { getProvider } = await import('$lib/server/providers/registry');
			const provider = getProvider(providerId);
			const url = typeof payload.url === 'string' ? payload.url : '';
			const parsedRef = url ? await provider.parseRef(url).catch(() => null) : null;
			const ref = { provider: provider.id, id: parsedRef?.id ?? url };
			const m = await provider.metadata(ref);
			title = m.title;
			artist = m.artist;
			album = m.album;
			isrc = m.isrc;
			coverUrl = m.coverUrl;
			year = m.year;
			durationSec = m.durationSec;
		} catch {
			// metadata unavailable — placeholder with what we know
		}
	}
	if (!title) title = `Failed download (${providerId})`;
	if (!artist) artist = 'Unknown Artist';

	const { ensureFailedTrackRow } = await import('$lib/server/db/tracks');
	const { canonicalTrackId } = await import('$lib/server/providers/ids');
	const rawId = typeof payload.url === 'string' ? payload.url : null;
	await ensureFailedTrackRow({
		provider: providerId,
		providerTrackId: canonicalTrackId(providerId, rawId) ?? rawId,
		title,
		artist,
		album,
		isrc,
		coverUrl,
		sourceUrl: typeof payload.url === 'string' ? payload.url : null,
		year,
		durationSec,
		error,
	});
}
