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
			// retries (30m), cross-provider quality upgrades (1h), metadata+cover
			// repair (1h). All are rate-limited by the jobs table itself.
			const lyricsSweep = setInterval(() => void lyricsBackfillSweep(), 5 * 60_000);
			lyricsSweep.unref?.();
			const retrySweep = setInterval(() => void downloadRetrySweep(), 30 * 60_000);
			retrySweep.unref?.();
			const upgradeSweep = setInterval(() => void qualityUpgradeSweep(), 60 * 60_000);
			upgradeSweep.unref?.();
			// Metadata repair runs on the SAME cadence as the quality upgrade sweep:
			// songs with broken covers or a missing album are monitored just as
			// aggressively as songs awaiting a better master.
			const metadataSweep = setInterval(() => void metadataRepairSweep(), 60 * 60_000);
			metadataSweep.unref?.();

			// Reindex top-up. The hourly metadata sweep only offers 25 GAP-based
			// candidates, so a row that has an album and a cover but no genre is never
			// selected — which is how the reindex stalled at 414/715 with an empty
			// queue and 301 rows nobody was ever going to ask about again. This walks
			// the never-refreshed rows directly, so the index finishes on its own
			// without anyone having to babysit a loop.
			const reindexSweep = setInterval(() => void reindexTopUpSweep(), 10 * 60_000);
			reindexSweep.unref?.();
			void reindexTopUpSweep();
			void lyricsBackfillSweep();
			void downloadRetrySweep();
			void qualityUpgradeSweep();
			void metadataRepairSweep();

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
			 * 24-bit ceiling, ask ALL configured providers (Tidal AND Deezer
			 * AND …) for the best available version — ISRC-exact when possible.
			 * One provider up = it takes precedence; both up = best quality wins.
			 * Enqueued upgrades refetch lyrics; a downed lyrics API keeps existing
			 * sidecars (handled by the lyrics job).
			 *
			 * Gated by the `autoUpgradeQuality` setting. Turning it off stops
			 * only THIS sweep: the failed-download retry sweep is independent, so
			 * missing music is still fetched. Without the gate, a track whose
			 * best available master is 16-bit would otherwise be re-examined
			 * every hour forever.
			 */
			async function qualityUpgradeSweep(): Promise<void> {
				try {
					const { getSettings } = await import('$lib/server/settings');
					if (!(await getSettings()).autoUpgradeQuality) {
						log.debug('quality upgrade sweep disabled by settings');
						return;
					}
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

			/**
			 * Metadata + cover repair sweep. Runs hourly on the same cadence as the
			 * quality upgrade sweep: any filed row with a missing album, missing
			 * cover art, or missing album-artist/genre/year/ISRC gets an enrichment
			 * job. Each job fills only what is absent, writes the cover, force-retags
			 * the file and relocates it when a newly-found album changes its folder.
			 */
			/**
			 * Keep the reindex moving without supervision.
			 *
			 * Enqueues rows that have never been through a metadata pass, oldest first.
			 * Not forced: this is about covering rows nobody has looked at, not
			 * re-querying the ones already done. `tracksWithPendingJob` stops it piling
			 * duplicates on rows already in flight.
			 */
			async function reindexTopUpSweep(): Promise<void> {
				try {
					const { listReindexCandidates } = await import('$lib/server/db/tracks');
					const { enqueueJob, tracksWithPendingJob } = await import('./jobs');
					const busy = await tracksWithPendingJob('metadata_repair');
					const candidates = await listReindexCandidates(60);
					let enqueued = 0;
					for (const row of candidates) {
						if (busy.has(row.id)) continue;
						// Only rows that have NEVER been refreshed; once stamped, the
						// ordering moves them to the back naturally.
						if (row.metadataRefreshedAt) break;
						await enqueueJob({
							type: 'metadata_repair',
							payload: { trackId: row.id, reason: 'reindex-topup' },
							trackId: row.id,
							// Behind a user's own download, but ahead of the hourly sweep.
							priority: 4,
						});
						enqueued++;
					}
					if (enqueued > 0) {
						log.info('reindex top-up enqueued', { count: enqueued });
					}
				} catch (err) {
					log.warn('reindex top-up failed', { error: String(err) });
				}
			}

			async function metadataRepairSweep(): Promise<void> {
				try {
					const { listMetadataRepairCandidates, listBrokenCoverCandidates } =
						await import('$lib/server/db/tracks');
					const { enqueueJob } = await import('./jobs');

					// Metadata gaps (album first, then covers) and rows whose cover
					// is recorded but whose art may be stale/broken on disk.
					const candidates = await listMetadataRepairCandidates(25);
					const covers = await listBrokenCoverCandidates(25);
					const seen = new Set<string>();
					let enqueued = 0;
					for (const c of [...candidates, ...covers]) {
						if (seen.has(c.id)) continue;
						seen.add(c.id);
						await enqueueJob({
							type: 'metadata_repair',
							payload: { trackId: c.id, reason: 'sweep' },
							trackId: c.id,
							priority: 6,
						});
						enqueued++;
						log.info('metadata repair enqueued', {
							trackId: c.id,
							title: c.title,
							missingAlbum: !c.album,
							missingCover: !('coverPath' in c) || !c.coverPath,
						});
					}
					if (enqueued > 0) {
						log.info('metadata repair sweep enqueued batch', { enqueued });
					}
				} catch (err) {
					log.debug('metadata repair sweep skipped', { error: String(err) });
				}
			}

			/**
			 * Failed-download retry sweep: 6h cooldown per track, oldest first.
			 *
			 * Before requeueing on the same (possibly still-broken) provider it
			 * asks the upgrade engine for the best offer across every enabled
			 * provider. A track that failed on one source may be available — in
			 * better quality — on another, which is strictly preferable to
			 * retrying the same broken source.
			 */
			async function downloadRetrySweep(): Promise<void> {
				try {
					const { listFailedDownloadTracks, getTrackById, markDownloadStatus } =
						await import('$lib/server/db/tracks');
					const { findBestUpgrade } = await import('./upgrades');
					const { trackPageUrl } = await import('$lib/server/providers/ids');
					const { enqueueJob } = await import('./jobs');
					const rows = await listFailedDownloadTracks(5);
					for (const row of rows) {
						const full = await getTrackById(row.id);
						const own =
							row.sourceUrl ?? trackPageUrl(row.provider, row.providerTrackId) ?? '';
						const upgrade = full
							? await findBestUpgrade(
									{
										id: full.id,
										provider: full.provider,
										providerTrackId: full.providerTrackId,
										title: full.title,
										artist: full.artist,
										album: full.album,
										isrc: full.isrc,
										sourceUrl: full.sourceUrl,
										durationSec: full.durationSec,
										year: full.releaseYear,
										genre: full.genre,
										format: full.format,
										bitrateKbps: full.bitrateKbps,
										bitDepth: full.bitDepth,
										isLossless: full.isLossless,
									},
									{ skipRecentCheck: true },
								).catch(() => null)
							: null;
						const payload = upgrade
							? {
									url: upgrade.meta.sourceUrl ?? upgrade.meta.providerTrackId,
									provider: upgrade.provider,
									retryForTrackId: row.id,
									meta: {
										title: upgrade.meta.title,
										artist: upgrade.meta.artist,
										album: upgrade.meta.album,
										isrc: upgrade.meta.isrc,
										coverUrl: upgrade.meta.coverUrl,
										year: upgrade.meta.year,
									},
								}
							: {
									url: own,
									provider: row.provider,
									retryForTrackId: row.id,
									meta: { title: row.title, artist: row.artist },
								};
						if (!payload.url) continue;
						await enqueueJob({ type: 'download', payload, trackId: row.id });
						await markDownloadStatus(row.id, 'pending');
						log.info('failed download requeued', {
							trackId: row.id,
							title: row.title,
							via: payload.provider,
						});
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

/** Record why a job failed against a row that already exists. */
async function logFailureForTrack(trackId: string, error: string): Promise<void> {
	try {
		const { auditLog } = await import('$lib/server/db/schema');
		const { db } = await import('$lib/server/db');
		await db
			.insert(auditLog)
			.values({
				event: 'download.failed',
				userId: null,
				metadata: { trackId, error: error.slice(0, 300) },
			})
			.catch(() => undefined);
	} catch {
		// The failure is already reflected in the row's status; the audit entry is
		// best-effort and must never mask it.
	}
}

/** Best-effort placeholder row so failed downloads are visible + retryable. */
async function recordFailedDownload(job: JobRow, error: string): Promise<void> {
	const payload = job.payload as {
		url?: string;
		provider?: string;
		meta?: Record<string, unknown>;
		retryForTrackId?: string;
		upgradeForTrackId?: string;
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

	// A retry or upgrade already knows WHICH row it was working on. Recording the
	// failure against that row is essential: the failure is reported using the
	// RELOCATED provider and track id, so without this the (provider,
	// provider_track_id) conflict target misses the original row entirely and a
	// second row is inserted for the same song. That is how pressing "Retry all
	// failed" turned 10 failures into 47 and left "Jane!" in the library twice.
	const targetId = payload.retryForTrackId ?? payload.upgradeForTrackId ?? null;
	if (targetId) {
		const { markDownloadStatus } = await import('$lib/server/db/tracks');
		if (payload.upgradeForTrackId && !payload.retryForTrackId) {
			// An UPGRADE failed, not a download. The track is present, filed and
			// playing — only a better copy was unobtainable, which is common and
			// says nothing about the track's own state. Marking it `failed` made a
			// song you can hear show up in the failed list, and the dashboard's
			// remove-from-database button on such a row would take away the file.
			// The reason is still recorded against the track, just not as a status.
			await logFailureForTrack(targetId, error);
			log.info('upgrade failed; existing track left completed', {
				trackId: targetId,
				jobId: job.id,
				error,
			});
			return;
		}
		await markDownloadStatus(targetId, 'failed');
		await logFailureForTrack(targetId, error);
		log.info('failure recorded against existing track', { trackId: targetId, jobId: job.id });
		return;
	}

	const { ensureFailedTrackRow, findTrackByIsrc } = await import('$lib/server/db/tracks');
	const { canonicalTrackId } = await import('$lib/server/providers/ids');
	const rawId = typeof payload.url === 'string' ? payload.url : null;
	const canonicalId = canonicalTrackId(providerId, rawId);

	// Never fall back to the URL in provider_track_id.
	//
	// That column is part of the (provider, provider_track_id) unique key, so
	// writing "https://www.deezer.com/track/2421366" there created a SECOND row for
	// a song that already had a proper one keyed "2421366" — 29 of them, titled
	// "Failed download" by "Unknown Artist", because the URL can never match an ISRC
	// lookup or a canonical id. The artist link leaked in the same way, storing
	// ".../fr/artist/110750" as if it were a track.
	if (!canonicalId) {
		log.info('no canonical track id; not creating a placeholder row', {
			jobId: job.id,
			provider: providerId,
			url: rawId,
		});
		return;
	}

	// If we know the recording, find its row and fail THAT. Otherwise every job for
	// a track whose metadata resolved would add another orphan row.
	if (isrc) {
		const existing = await findTrackByIsrc(isrc).catch(() => null);
		if (existing) {
			const { markDownloadStatus } = await import('$lib/server/db/tracks');
			await markDownloadStatus(existing.id, 'failed');
			await logFailureForTrack(existing.id, error);
			log.info('failure recorded against the row with that ISRC', {
				trackId: existing.id,
				isrc,
				jobId: job.id,
			});
			return;
		}
	}

	// The track may already be in the library under a DIFFERENT provider — a
	// locally adopted file has provider `local`, so an ISRC lookup misses it, and
	// the failure then inserts a second row for a song that is present and filed.
	// That is how 7 tracks of PRETTY DOLLCORPSE came to appear as failed while the
	// same songs played from their adopted files.
	const { findTrackByIdentity } = await import('$lib/server/db/tracks');
	const equivalent = await findTrackByIdentity({
		artist,
		album,
		title,
		isrc,
		durationSec,
	}).catch(() => null);
	if (equivalent) {
		await logFailureForTrack(equivalent.id, error);
		log.info('failure recorded against the existing local row; no shadow row created', {
			trackId: equivalent.id,
			provider: equivalent.provider,
			jobId: job.id,
		});
		return;
	}

	await ensureFailedTrackRow({
		provider: providerId,
		providerTrackId: canonicalId,
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
