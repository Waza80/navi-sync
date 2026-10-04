import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';
import { getSettings } from '$lib/server/settings';
import {
	findExistingTrack,
	getTrackById,
	updateLyricsStatus,
	upsertTrack,
} from '$lib/server/db/tracks';
import { updateProgress, type JobRow } from './jobs';
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

	// 2. Metadata.
	await ctx.report(8, 'fetching metadata');
	const meta: TrackMeta = await provider.metadata(ref);
	await ctx.report(15, `metadata: ${meta.artist} — ${meta.title}`);

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

	// 5. Download to temp (progress 25→65).
	const tmpRaw = join(env.MUSIC_TMP_DIR, `job-${job.id}.raw`);
	await ctx.report(25, 'downloading');
	try {
		await downloadWithProgress(resolution.url, tmpRaw, ctx, job, meta);
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
	if (!lyrics.success) {
		await updateLyricsStatus(trackId, 'failed').catch(() => undefined);
	}

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
	await downloadToFile(url, dest, {
		signal: ctx.signal,
		onProgress: (fraction) => {
			const pct = 25 + Math.floor(fraction * 40); // 25..65
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
	await updateLyricsStatus(
		t.id,
		result.success ? (result.synced ? 'synced' : 'plain') : 'failed',
	);
	if (!result.success) {
		// Contained failure: job succeeds but reports the lyrics failure loudly.
		return { success: false, error: result.error ?? 'all sources failed' };
	}
	return { success: true, synced: result.synced ?? false, path: result.path };
}

/* ── navidrome scan ───────────────────────────────────────────────────────── */

async function runNavidromeScan(job: JobRow): Promise<Record<string, unknown>> {
	const { getSettings } = await import('$lib/server/settings');
	const s = await getSettings();
	if (!s.navidromeUrl || !s.navidromeUsername || !s.navidromePassword) {
		throw new Error('Navidrome not configured (URL, username and password required)');
	}
	await updateProgress(job.id, job.type, job.trackId, 40, 'triggering scan');
	const result = await startScan(s.navidromeUrl, s.navidromeUsername, s.navidromePassword);
	if (!result.ok) throw new Error(`Scan failed: ${result.error ?? 'unknown error'}`);
	log.info('navidrome scan triggered', { serverVersion: result.serverVersion });
	return { status: 'ok', serverVersion: result.serverVersion };
}
