import { join } from 'node:path';
import { rm, stat } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';
import { getSettings } from '$lib/server/settings';
import {
	deleteTrackRow,
	findExistingTrack,
	getTrackById,
	markDownloadStatus,
	updateLyricsStatus,
	upsertTrack,
} from '$lib/server/db/tracks';
import { isSameRecording } from '$lib/shared/quality';
import { enqueueJob, updateProgress, type JobRow } from './jobs';
import { downloadLyrics } from '$lib/server/lyrics';
import { providers } from '$lib/server/providers/registry';
import { ProviderError, type StreamResolution, type TrackMeta } from '$lib/server/providers/types';
import { shouldSkipRefetch } from '$lib/shared/quality';
import { cleanupTemp, moveIntoLibrary, sha256File } from '$lib/server/library/files';
import { fetchCover, probeQuality, tagFlac, tagMp3 } from '$lib/server/library/tagging';
import { trackBaseRelativePath, coverRelativePath } from '$lib/server/library/paths';
import { startScan } from '$lib/server/navidrome/subsonic';
import { decryptStripeFile } from '$lib/server/providers/deezer/blowfish';
import { downloadToFile } from '$lib/server/providers/deezer/media';

/**
 * Job handlers. Every handler receives an abort signal (user cancellation)
 * and a progress reporter. Errors propagate to failJob() for backoff/dead-letter.
 */

const log = logger;

export interface JobContext {
	signal: AbortSignal;
	report(progress: number, stage: string): Promise<void>;
}

export async function runJob(job: JobRow, ctx: JobContext): Promise<Record<string, unknown>> {
	switch (job.type) {
		case 'download':
			return runDownload(job, ctx);
		case 'lyrics':
			return runLyrics(job, ctx);
		case 'navidrome_scan':
			return runNavidromeScan(job);
		case 'upgrade_check':
			return runUpgradeCheck(job, ctx);
		default:
			throw new Error(`No handler for job type: ${job.type}`);
	}
}

/* ── download ─────────────────────────────────────────────────────────────── */

async function runDownload(job: JobRow, ctx: JobContext): Promise<Record<string, unknown>> {
	const payload = job.payload as { url?: string; provider?: string };
	const input = payload.url;
	if (typeof input !== 'string' || input.trim().length === 0) {
		throw new Error('Download job payload missing "url"');
	}

	// 1. Route to a provider (registry order = graceful degradation order).
	const provider = payload.provider
		? providers.find((p) => p.id === payload.provider)
		: providers.find((p) => p.matches(input.trim()));
	if (!provider) {
		throw new ProviderError(
			`No provider supports: ${input.slice(0, 100)}`,
			'PROVIDER_UNAVAILABLE',
		);
	}
	const ref = await provider.parseRef(input);
	if (!ref)
		throw new ProviderError(
			`URL did not resolve to a ${provider.displayName} track`,
			'NOT_FOUND',
		);

	// 2. Metadata. Providers without bare-id metadata (Monochrome) receive the
	// search snapshot via the job payload — but stream grants (TRACK_TOKEN)
	// expire, so always refresh from the provider when possible.
	const payloadMeta = job.payload['meta'] as Partial<TrackMeta> | undefined;
	let meta: TrackMeta;
	if (
		payloadMeta &&
		typeof payloadMeta.title === 'string' &&
		typeof payloadMeta.artist === 'string'
	) {
		meta = {
			provider: provider.id,
			providerTrackId: ref.id,
			title: payloadMeta.title,
			artist: payloadMeta.artist,
			album: payloadMeta.album ?? null,
			albumArtist: payloadMeta.artist,
			isrc: payloadMeta.isrc ?? null,
			trackNumber: payloadMeta.trackNumber ?? null,
			discNumber: null,
			durationSec: payloadMeta.durationSec ?? null,
			year: payloadMeta.year ?? null,
			genre: null,
			coverUrl: payloadMeta.coverUrl ?? null,
			sourceUrl: ref.sourceUrl ?? null,
			streamToken: null,
		};
		await ctx.report(10, 'refreshing stream grant');
		try {
			const fresh = await provider.metadata(ref);
			meta = { ...meta, ...fresh, streamToken: fresh.streamToken ?? null };
			await ctx.report(15, `metadata: ${meta.artist} — ${meta.title}`);
		} catch (err) {
			// Providers without bare-id metadata (Monochrome) keep the search
			// snapshot — their streams need no per-track grant.
			log.debug('fresh metadata unavailable, using search snapshot', {
				jobId: job.id,
				provider: provider.id,
				error: err instanceof Error ? err.message : String(err),
			});
			await ctx.report(12, `metadata (from search): ${meta.artist} — ${meta.title}`);
		}
	} else {
		await ctx.report(8, 'fetching metadata');
		meta = await provider.metadata(ref);
		await ctx.report(15, `metadata: ${meta.artist} — ${meta.title}`);
	}

	// 3. Guardrails (spec: 24-bit hard stop, no pointless re-downloads).
	const settings = await getSettings();
	const existing = await findExistingTrack(meta);
	if (existing) {
		const verdict = shouldSkipRefetch(
			{
				format: existing.format,
				bitrateKbps: existing.bitrateKbps,
				bitDepth: existing.bitDepth,
				isLossless: existing.isLossless,
			},
			// Incoming can't be better than the provider's best possible offer:
			{
				format: settings.preferLossless ? 'flac' : 'mp3',
				bitrateKbps: null,
				bitDepth: settings.preferLossless ? 24 : null,
				isLossless: settings.preferLossless,
			},
		);
		if (verdict.skip) {
			log.info('download skipped by quality guardrail', {
				jobId: job.id,
				reason: verdict.reason,
				existingTrackId: existing.id,
			});
			return { skipped: true, reason: verdict.reason, trackId: existing.id };
		}
	}

	// 4. Resolve stream honoring the quality policy.
	await ctx.report(20, 'resolving stream');
	const resolution: StreamResolution = await provider.resolve(meta, {
		preferLossless: settings.preferLossless,
		minBitrateKbps: settings.minBitrateKbps,
		allowLowerFallback: settings.allowLowerFallback,
	});

	// 5. Download to temp (progress 25→65). Chunked providers (Cloudflare
	// caps) use parallel Range chunks; everything else is a single stream.
	const tmpRaw = join(env.MUSIC_TMP_DIR, `job-${job.id}.raw`);
	await ctx.report(25, 'downloading');
	try {
		if (resolution.chunked) {
			const { downloadChunked } = await import('$lib/server/providers/monochrome/client');
			let lastPct = 25;
			await downloadChunked(resolution.url, tmpRaw, {
				signal: ctx.signal,
				onProgress: (received, total) => {
					const pct = 25 + Math.floor((received / total) * 40); // 25..65
					if (pct !== lastPct && pct % 5 === 0) {
						lastPct = pct;
						void updateProgress(
							job.id,
							job.type,
							job.trackId,
							pct,
							`downloading ${meta.title} (${Math.round(received / 1024 / 1024)}MB)`,
						).catch(() => undefined);
					}
				},
			});
		} else {
			await downloadWithProgress(resolution.url, tmpRaw, ctx, job, meta);
		}
	} catch (err) {
		await cleanupTemp(tmpRaw);
		throw err;
	}

	// 6. Decrypt if the stream is BF_CBC_STRIPE.
	let finalTmp = tmpRaw;
	if (resolution.cipher === 'BF_CBC_STRIPE') {
		if (!resolution.decryptTrackId) throw new Error('Encrypted stream without track id');
		await ctx.report(68, 'decrypting');
		const tmpDec = join(env.MUSIC_TMP_DIR, `job-${job.id}.dec`);
		try {
			await decryptTo(tmpRaw, tmpDec, resolution.decryptTrackId, ctx.signal);
		} catch (err) {
			await cleanupTemp(tmpRaw);
			await cleanupTemp(tmpDec);
			throw err;
		}
		await cleanupTemp(tmpRaw);
		finalTmp = tmpDec;
	}
	if (ctx.signal.aborted) {
		await cleanupTemp(finalTmp);
		throw new Error('cancelled');
	}

	// 7. Probe real quality (DB stores measured, not claimed).
	await ctx.report(74, 'verifying audio');
	const probed = await probeQuality(finalTmp).catch(() => null);

	// 8. Tag + embed cover.
	await ctx.report(78, 'tagging');
	const cover = await fetchCover(meta.coverUrl);
	const tags = {
		title: meta.title,
		artist: meta.artist,
		album: meta.album,
		albumArtist: meta.albumArtist,
		trackNumber: meta.trackNumber,
		discNumber: meta.discNumber,
		year: meta.year,
		genre: meta.genre,
		cover,
		lyricsPlain: null,
	};
	try {
		if (resolution.ext === 'flac') await tagFlac(finalTmp, tags);
		else tagMp3(finalTmp, tags);
	} catch (err) {
		// Tagging failure must not lose the audio; log and continue.
		log.warn('tagging failed, storing untagged file', { error: String(err) });
	}

	// 9. Lyrics BEFORE moving (sidecar lands next to audio path directly).
	await ctx.report(84, 'lyrics');
	const lyrics = await downloadLyrics(meta);

	// 10. Move into the library (Artist/Album/NN - Title.ext).
	await ctx.report(90, 'filing into library');
	const checksum = await sha256File(finalTmp);
	const audioRel = `${trackBaseRelativePath(meta)}.${resolution.ext}`;
	const finalPath = await moveIntoLibrary(finalTmp, audioRel);
	await cleanupTemp(finalTmp);

	let coverPath: string | null = null;
	if (cover) {
		try {
			const coverTmp = join(env.MUSIC_TMP_DIR, `job-${job.id}-cover.jpg`);
			await writeFile(coverTmp, cover);
			coverPath = await moveIntoLibrary(coverTmp, coverRelativePath(meta));
		} catch {
			coverPath = null;
		}
	}

	// 11. Persist track row.
	await ctx.report(96, 'updating database');
	const size = await stat(finalPath).then((s) => s.size);
	const upgradeForTrackId =
		typeof job.payload['upgradeForTrackId'] === 'string'
			? job.payload['upgradeForTrackId']
			: null;
	// Supersede rule: an explicit upgrade target always replaces; otherwise
	// only when both rows carry the SAME ISRC (exact same recording — never
	// guess across title/artist-only matches). The new file passed the
	// guardrail as strictly better quality.
	const supersededId =
		upgradeForTrackId ??
		(existing && isSameRecording(existing.isrc, meta.isrc) ? existing.id : null);
	let supersededFilePath: string | null = null;
	if (supersededId) {
		const previous = await getTrackById(supersededId);
		supersededFilePath =
			previous && typeof previous['filePath'] === 'string' ? previous['filePath'] : null;
		if (supersededFilePath && supersededFilePath !== finalPath) {
			await rm(supersededFilePath, { force: true }).catch((err) =>
				log.warn('superseded file cleanup failed', {
					path: supersededFilePath,
					error: String(err),
				}),
			);
		}
	}
	const trackId = await upsertTrack({
		meta,
		resolution,
		probed,
		filePath: finalPath,
		coverPath,
		sizeBytes: size,
		checksumSha256: checksum,
		lyricsStatus: lyrics.success ? (lyrics.synced ? 'synced' : 'plain') : 'failed',
	});
	if (supersededId && supersededId !== trackId) {
		// The old row loses: remove orphaned sidecars that no longer belong
		// to any track (cover.jpg is shared per album — never delete it).
		if (supersededFilePath) {
			const oldBase = supersededFilePath.replace(/\.(mp3|flac)$/i, '');
			const newBase = finalPath.replace(/\.(mp3|flac)$/i, '');
			for (const ext of ['lrc', 'txt']) {
				const sidecar = `${oldBase}.${ext}`;
				if (sidecar !== `${newBase}.${ext}`) {
					await rm(sidecar, { force: true }).catch(() => undefined);
				}
			}
		}
		const removed = await deleteTrackRow(supersededId).catch(() => false);
		log.info('superseded track row replaced', {
			jobId: job.id,
			oldTrackId: supersededId,
			newTrackId: trackId,
			rowRemoved: removed,
		});
	}
	if (upgradeForTrackId) {
		// Refetch lyrics for the surviving row after a quality upgrade.
		try {
			await enqueueJob({ type: 'lyrics', payload: { trackId }, trackId });
		} catch (err) {
			log.warn('post-upgrade lyrics refetch enqueue failed', { trackId, error: String(err) });
		}
	}
	await markDownloadStatus(trackId, 'completed');

	return {
		trackId,
		format: resolution.format,
		claimedBitrateKbps: resolution.claimedBitrateKbps,
		probed: probed
			? {
					container: probed.container,
					bitrateKbps: probed.bitrateKbps,
					bitDepth: probed.bitDepth,
					sampleRateHz: probed.sampleRateHz,
					lossless: probed.lossless,
				}
			: null,
		lyrics: {
			success: lyrics.success,
			synced: lyrics.synced ?? false,
			path: lyrics.path ?? null,
		},
		filePath: finalPath,
	};
}

async function downloadWithProgress(
	url: string,
	dest: string,
	ctx: JobContext,
	job: JobRow,
	meta: TrackMeta,
): Promise<void> {
	let lastPct = 0;
	let mb = 0;
	await downloadToFile(url, dest, {
		signal: ctx.signal,
		onProgress: (fraction) => {
			// fraction < 0 = unknown total (byte-milestone sentinel)
			const pct =
				fraction < 0
					? Math.min(64, 25 + Math.floor((mb += 5) / 2))
					: 25 + Math.floor(fraction * 40); // 25..65
			if (pct !== lastPct && pct % 5 === 0) {
				lastPct = pct;
				void updateProgress(
					job.id,
					job.type,
					job.trackId,
					pct,
					`downloading ${meta.title} (${pct}%)`,
				).catch(() => undefined);
			}
		},
	});
}

async function decryptTo(
	src: string,
	dest: string,
	trackId: string,
	signal: AbortSignal,
): Promise<void> {
	await decryptStripeFile(src, dest, trackId, signal);
}

/* ── lyrics ───────────────────────────────────────────────────────────────── */

async function runLyrics(job: JobRow, ctx: JobContext): Promise<Record<string, unknown>> {
	const payload = job.payload as { trackId?: string };
	if (typeof payload.trackId !== 'string') throw new Error('lyrics job missing trackId');
	await ctx.report(20, 'loading track');
	const track = await getTrackById(payload.trackId);
	if (!track) throw new Error(`Track not found: ${payload.trackId}`);
	const t = track as {
		filePath: string | null;
		provider: string;
		providerTrackId: string | null;
		title: string;
		artist: string;
		album: string | null;
		albumArtist: string | null;
		isrc: string | null;
		trackNumber: number | null;
		discNumber: number | null;
		durationSec: number | null;
		releaseYear: number | null;
		genre: string | null;
		sourceUrl: string | null;
		id: string;
	};

	const meta: TrackMeta = {
		provider: t.provider,
		providerTrackId: t.providerTrackId ?? '',
		title: t.title,
		artist: t.artist,
		album: t.album,
		albumArtist: t.albumArtist,
		isrc: t.isrc,
		trackNumber: t.trackNumber,
		discNumber: t.discNumber,
		durationSec: t.durationSec,
		year: t.releaseYear,
		genre: t.genre,
		coverUrl: null,
		sourceUrl: t.sourceUrl,
		streamToken: null,
	};
	await ctx.report(50, 'querying lyrics sources');
	const result = await downloadLyrics(meta);
	if (!result.success) {
		// "If the lyrics API is down, keep the same": when a sidecar already
		// exists for this track, keep the current status untouched.
		const base =
			typeof t.filePath === 'string' ? t.filePath.replace(/\.(mp3|flac)$/i, '') : null;
		const hasSidecar = base
			? await stat(`${base}.lrc`)
					.then(
						() => true,
						() => false,
					)
					.then(async (lrc) =>
						lrc
							? true
							: await stat(`${base}.txt`).then(
									() => true,
									() => false,
								),
					)
			: false;
		if (hasSidecar) {
			log.info('lyrics fetch failed — keeping existing sidecar', { trackId: t.id });
			return { success: false, kept: true, error: result.error ?? 'all sources failed' };
		}
		await updateLyricsStatus(t.id, 'failed');
		return { success: false, error: result.error ?? 'all sources failed' };
	}
	await updateLyricsStatus(t.id, result.synced ? 'synced' : 'plain');
	return { success: true, synced: result.synced ?? false, path: result.path };
}

/* ── navidrome scan ───────────────────────────────────────────────────────── */

async function runNavidromeScan(job: JobRow): Promise<Record<string, unknown>> {
	const { getSettings } = await import('$lib/server/settings');
	const { getScanStatus } = await import('$lib/server/navidrome/subsonic');
	const s = await getSettings();
	if (!s.navidromeUrl || !s.navidromeUsername || !s.navidromePassword) {
		throw new Error('Navidrome not configured (URL, username and password required)');
	}
	const payload = job.payload as { repair?: boolean; filesOnDisk?: number; tracksInDb?: number };
	await updateProgress(job.id, job.type, job.trackId, 40, 'triggering scan');
	const started = await startScan(s.navidromeUrl, s.navidromeUsername, s.navidromePassword);
	if (!started.ok) throw new Error(`Scan failed: ${started.error ?? 'unknown error'}`);
	log.info('navidrome scan triggered', { serverVersion: started.serverVersion });

	// Wait for Navidrome to finish (poll every 5s, up to 5 min) so a repair
	// reports the true outcome instead of "triggered and hoped".
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
	let scanCompleted = false;
	let lastCount: number | null = null;
	for (let i = 0; i < 60; i++) {
		await sleep(5000);
		const status = await getScanStatus(
			s.navidromeUrl,
			s.navidromeUsername,
			s.navidromePassword,
		);
		if (!status.ok) {
			log.warn('navidrome scan-status poll failed', { error: status.error });
			continue;
		}
		lastCount = status.count ?? lastCount;
		if (!status.scanning) {
			scanCompleted = true;
			break;
		}
		await updateProgress(
			job.id,
			job.type,
			job.trackId,
			60,
			`scan running (${status.count ?? '?'} tracks indexed)`,
		);
	}
	const { markLibrarySynced } = await import('$lib/server/db/tracks');
	const stamped = scanCompleted
		? await markLibrarySynced().catch((err) => {
				log.warn('navidrome sync-stamp failed', { error: String(err) });
				return 0;
			})
		: 0;
	log.info('navidrome scan finished', {
		scanCompleted,
		lastCount,
		stamped,
		repair: payload.repair ?? false,
	});
	return {
		status: 'ok',
		serverVersion: started.serverVersion,
		scanCompleted,
		lastScanCount: lastCount,
		stamped,
		filesOnDisk: payload.filesOnDisk ?? null,
		tracksInDb: payload.tracksInDb ?? null,
	};
}

/* ── upgrade_check ──────────────────────────────────────────────────────── */

/**
 * Forced quality check for one track (user-triggered or sweep). Re-resolves
 * the best stream and compares measured ranks; strictly better → download
 * with lyrics refetch; otherwise completes with noUpgrade.
 */
async function runUpgradeCheck(job: JobRow, ctx: JobContext): Promise<Record<string, unknown>> {
	const payload = job.payload as { trackId?: string };
	if (typeof payload.trackId !== 'string') throw new Error('upgrade_check missing trackId');
	const row = await getTrackById(payload.trackId);
	if (!row) throw new Error(`Track not found: ${payload.trackId}`);
	const t = row;
	if (!t.providerTrackId) throw new Error('Track has no provider link (uploads cannot upgrade)');

	await ctx.report(20, 'asking every provider for a better version');
	const { findBestUpgrade } = await import('./upgrades');
	// User-initiated: bypass the sweep's 24h cooldown (the sweep keeps its own).
	const upgrade = await findBestUpgrade(
		{
			id: t.id,
			provider: t.provider,
			providerTrackId: t.providerTrackId,
			title: t.title,
			artist: t.artist,
			album: t.album,
			isrc: t.isrc,
			sourceUrl: t.sourceUrl,
			durationSec: t.durationSec,
			year: t.releaseYear,
			genre: t.genre,
			format: t.format,
			bitrateKbps: t.bitrateKbps,
			bitDepth: t.bitDepth,
			isLossless: t.isLossless,
		},
		{ skipRecentCheck: true },
	);

	if (!upgrade) {
		log.info('upgrade check: already at best available quality', { trackId: t.id });
		return { upgrade: false };
	}

	await ctx.report(70, 'better quality found — queueing upgrade');
	await enqueueJob({
		type: 'download',
		payload: {
			url: upgrade.meta.sourceUrl ?? upgrade.meta.providerTrackId,
			provider: upgrade.provider,
			upgradeForTrackId: t.id,
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
		trackId: t.id,
		priority: 8,
	});
	return { upgrade: true, incomingRank: upgrade.incomingRank, provider: upgrade.provider };
}
