import { join } from 'node:path';
import { access, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';
import { getSettings } from '$lib/server/settings';
import {
	deleteTrackRow,
	findExistingTrack,
	getTrackById,
	listFiledTracks,
	markDownloadStatus,
	updateLyricsStatus,
	upsertTrack,
} from '$lib/server/db/tracks';
import { isSameRecording } from '$lib/shared/quality';
import { enqueueJob, updateProgress, type JobRow } from './jobs';
import {
	downloadLyrics,
	lyricsSidecar,
	stripLrcTimestamps,
	type DownloadLyricsResult,
} from '$lib/server/lyrics';
import { findProviderForUrl, providers } from '$lib/server/providers/registry';
import { enabledProviders } from '$lib/server/providers/enabled';
import {
	ProviderError,
	type StreamResolution,
	type TrackMeta,
	type TrackRef,
} from '$lib/server/providers/types';
import type { MetadataField } from '$lib/server/metadata/types';
import { shouldSkipRefetch, shouldStopAlreadyDownloaded } from '$lib/shared/quality';
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
	// Assert the payload shape before doing anything with it.
	//
	// Payloads are jsonb, so the database constrains nothing and a handler reading
	// `payload.url` gets `undefined` at best — or a fan-out URL treated as a track,
	// which is what produced "Deezer gateway error on song.getData" for an ARTIST
	// link. Validating here means the job fails with the real reason instead.
	{
		const { validateJobPayload } = await import('$lib/server/db/validate');
		job.payload = validateJobPayload(job.type, job.payload) as JobRow['payload'];
	}

	switch (job.type) {
		case 'download':
			return runDownload(job, ctx);
		case 'lyrics':
			return runLyrics(job, ctx);
		case 'navidrome_scan':
			return runNavidromeScan(job);
		case 'upgrade_check':
			return runUpgradeCheck(job, ctx);
		case 'metadata_repair':
			return runMetadataRepair(job, ctx);
		default:
			throw new Error(`No handler for job type: ${job.type}`);
	}
}

/* ── download ─────────────────────────────────────────────────────────────── */

/**
 * True when a provider reached the track but could not hand over audio for it.
 *
 * Both providers raise NO_STREAM for exactly this: Deezer when the gateway
 * refuses media for a track it still lists (`media` empty, or "no sufficient
 * rights on requested media"), Tidal when a release has no playable master at
 * any tier it is willing to take. Both are per-track catalogue/rights facts, so
 * they are exactly the errors worth asking a second provider about — unlike
 * PROVIDER_UNAVAILABLE (the whole service is down, so retrying elsewhere proves
 * nothing) or NOT_FOUND (the track is not there to be fetched).
 */
function isStreamUnavailable(err: unknown): boolean {
	return err instanceof ProviderError && err.code === 'NO_STREAM';
}

async function runDownload(job: JobRow, ctx: JobContext): Promise<Record<string, unknown>> {
	const payload = job.payload as { url?: string; provider?: string };
	const input = payload.url;
	if (typeof input !== 'string' || input.trim().length === 0) {
		throw new Error('Download job payload missing "url"');
	}

	// 1. Route to a provider (registry order = graceful degradation order).
	//
	// A job may name its provider, but that name is NOT authority: settings can
	// have changed since the job was queued. Routing by a disabled provider made
	// retries keep failing against the exact source the user had turned off
	// (Deezer), even though the fix was simply to use Tidal. So an explicitly
	// named provider must still be ENABLED; otherwise fall back to URL routing
	// across the enabled set.
	const enabled = new Set((await enabledProviders()).map((p) => p.id));
	const named = payload.provider ? providers.find((p) => p.id === payload.provider) : undefined;
	let provider =
		named && enabled.has(named.id) ? named : await findProviderForUrl(input.trim(), enabled);
	if (named && !enabled.has(named.id)) {
		log.info('job named a disabled provider; re-routed', {
			jobId: job.id,
			requested: named.id,
			enabled: [...enabled].join(','),
		});
	}

	// Resolved up front so the failure messages can name the song instead of just
	// echoing an opaque URL.
	const rawMeta = (job.payload['meta'] ?? {}) as Partial<TrackMeta>;
	const trackRow = typeof job.trackId === 'string' ? await getTrackById(job.trackId) : null;
	const hintForError = {
		title: rawMeta.title ?? trackRow?.title ?? '',
		artist: rawMeta.artist ?? trackRow?.artist ?? '',
		isrc: rawMeta.isrc ?? trackRow?.isrc ?? null,
	};

	// A URL that no longer routes is not the end of the road. Jobs queued before
	// the Monochrome→Tidal migration still carry dead `tracks.monochrome.st`
	// links, and a Deezer link is useless once Deezer is off — in both cases the
	// job still knows the title and artist, so ask the enabled providers to find
	// the song instead of burning every attempt on an unresolvable URL.
	let ref: TrackRef | null = provider ? await provider.parseRef(input) : null;

	// A link can resolve to something that is not a track at all. A Deezer artist
	// link resolves to an id shaped exactly like a song id, so without this check
	// the pipeline fetched `song.getData` with an ARTIST id and reported
	// "Deezer gateway error on song.getData: No song data" — which says nothing
	// about the real problem and looks like a gateway fault.
	if (ref && ref.kind && ref.kind !== 'track') {
		log.info('link is not a track; refusing to download it as one', {
			jobId: job.id,
			kind: ref.kind,
			provider: provider?.id,
		});
		ref = null;
	}
	let relocated: { meta: TrackMeta } | null = null;
	if (!ref) {
		const hint = rawMeta;
		const { relocateTrack } = await import('$lib/server/queue/relocate');
		const found = await relocateTrack(
			{
				title: hint.title ?? trackRow?.title ?? '',
				artist: hint.artist ?? trackRow?.artist ?? '',
				album: hint.album ?? trackRow?.album ?? null,
				isrc: hint.isrc ?? trackRow?.isrc ?? null,
				durationSec: hint.durationSec ?? trackRow?.durationSec ?? null,
			},
			enabled,
		).catch(() => null);
		if (found) {
			provider = found.provider;
			ref = found.ref;
			relocated = found;
			log.info('unroutable URL; track relocated by name', {
				jobId: job.id,
				url: input.slice(0, 120),
				provider: provider.id,
			});
		}
	}
	if (!provider) {
		const who = `${hintForError.title ?? ''} — ${hintForError.artist ?? ''}`.trim();
		throw new ProviderError(
			`No enabled provider accepts ${input.slice(0, 80)}` +
				(who
					? `, and no enabled provider (${[...enabled].join(', ')}) has "${who}"` +
						`${hintForError.isrc ? ` by ISRC ${hintForError.isrc}` : ''}`
					: ''),
			'PROVIDER_UNAVAILABLE',
		);
	}
	if (!ref) {
		// Never print an empty quoted name: a job enqueued from a bare URL carries
		// no metadata at all, and `no provider has "" by name` reads like a bug
		// rather than "we were given nothing to search with".
		const who = hintForError.title
			? `"${hintForError.title}"${hintForError.artist ? ` by ${hintForError.artist}` : ''}`
			: null;
		throw new ProviderError(
			`URL did not resolve to a ${provider.displayName} track` +
				(who
					? `, and no enabled provider (${[...enabled].join(', ')}) has ${who} by name`
					: '. This job carried no title or artist, so it could not be looked up by name either — ' +
						'if it came from a fan-out, the source listing returned an unusable track reference'),
			'NOT_FOUND',
		);
	}
	if (relocated) {
		// The freshly-found metadata is better than whatever the stale job carried.
		job.payload = {
			...job.payload,
			meta: { ...(job.payload['meta'] as object), ...relocated.meta },
		};
	}

	// 2. Metadata. Providers without bare-id metadata receive the
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
			// Providers without bare-id metadata keep the search
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

	// 2b. Provider metadata can lack the album (bare-id lookups, stripped
	// payloads). Fill it from the catalog sources before the file is written,
	// so the library folder and tags are correct from the very first download.
	if (!meta.album || !meta.albumArtist || !meta.coverUrl) {
		await ctx.report(16, 'filling missing album metadata');
		meta = { ...(await enrichInline(meta)), streamToken: meta.streamToken };
	}

	// Hoisted: the already-downloaded hard stop below has to know whether this run
	// is a deliberate upgrade, and that flag is read several hundred lines further
	// down in the original ordering.
	const upgradeForTrackId =
		typeof job.payload['upgradeForTrackId'] === 'string'
			? job.payload['upgradeForTrackId']
			: null;

	// 3. Guardrails (spec: 24-bit hard stop, no pointless re-downloads).
	const settings = await getSettings();
	const existing = await findExistingTrack(meta);

	// 3a. HARD STOP: this recording already has audio on disk.
	//
	// The quality guardrail below only skips when the incoming copy cannot be
	// better, so anything ranked higher came back through — and when it did, the new
	// file was byte-different (it gets tagged, and a corrected year or embedded
	// lyrics changes the bytes) so `moveIntoLibrary` could not recognise it and wrote
	// "…(2).flac", "…(3).flac" beside the original. That is how one Tanger album
	// accumulated suffixed copies, and why Navidrome greys the album out: it sees
	// several files claiming one track number.
	//
	// An explicit upgrade still proceeds — that is the whole point of
	// `upgradeForTrackId`. Everything else stops, because a routine re-download of a
	// recording we already hold is never what was asked for.
	const hasFileOnDisk =
		existing != null &&
		typeof existing.filePath === 'string' &&
		existing.filePath.length > 0 &&
		(await access(existing.filePath).then(
			() => true,
			() => false,
		));
	const hardStop = shouldStopAlreadyDownloaded({
		hasFileOnDisk,
		isUpgrade: upgradeForTrackId != null,
	});
	if (hardStop.skip) {
		log.info('download skipped — this recording already has a file', {
			jobId: job.id,
			title: meta.title,
			artist: meta.artist,
			existingFile: existing?.filePath,
		});
		return { skipped: true, reason: hardStop.reason, trackId: existing?.id };
	}

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

	// 4. Resolve stream honoring the quality policy, rescuing across providers.
	//
	// Reaching metadata is NOT reaching audio. Deezer's catalog lists a track and
	// hands back full metadata, then refuses the stream itself — "Track token has
	// no sufficient rights on requested media" — which is how 30 Tanger tracks
	// across 3 albums failed while their neighbours downloaded fine. The metadata
	// step succeeded, so nothing had ever asked the OTHER provider for the audio.
	//
	// Relocation was already implemented for the case where the *URL* is dead; this
	// extends it to the case where the URL is fine and the *stream* is refused. Both
	// providers here do answer on ISRC, so the rescue is authoritative rather than a
	// guess by name.
	await ctx.report(20, 'resolving stream');
	let activeProvider = provider;
	let activeMeta = meta;
	let resolution: StreamResolution;
	try {
		resolution = await activeProvider.resolve(activeMeta, {
			preferLossless: settings.preferLossless,
			minBitrateKbps: settings.minBitrateKbps,
			allowLowerFallback: settings.allowLowerFallback,
		});
	} catch (err) {
		if (!isStreamUnavailable(err)) throw err;
		const others = new Set([...enabled].filter((id) => id !== activeProvider.id));
		if (others.size === 0) throw err;
		const { relocateTrack } = await import('$lib/server/queue/relocate');
		const rescue = await relocateTrack(
			{
				title: activeMeta.title,
				artist: activeMeta.artist,
				album: activeMeta.album,
				isrc: activeMeta.isrc,
				durationSec: activeMeta.durationSec,
			},
			others,
		);
		if (!rescue || rescue.provider.id === activeProvider.id) {
			log.info('no other enabled provider can supply this stream', {
				jobId: job.id,
				title: activeMeta.title,
				artist: activeMeta.artist,
				failedOn: activeProvider.id,
				tried: [...others].join(','),
			});
			throw err;
		}
		log.info('stream refused by routed provider; rescued on the other one', {
			jobId: job.id,
			title: activeMeta.title,
			artist: activeMeta.artist,
			from: activeProvider.id,
			to: rescue.provider.id,
			reason: err instanceof Error ? err.message.slice(0, 120) : String(err),
		});
		// Adopt the rescue wholesale: its metadata, its provider, its own stream
		// grant. The rest of the pipeline reads only `meta`, so from here on the
		// track is treated as having come from the rescuing provider.
		await ctx.report(
			21,
			`stream refused by ${activeProvider.displayName}; using ${rescue.provider.displayName}`,
		);
		activeProvider = rescue.provider;
		activeMeta = rescue.meta;
		meta = rescue.meta;
		resolution = await activeProvider.resolve(activeMeta, {
			preferLossless: settings.preferLossless,
			minBitrateKbps: settings.minBitrateKbps,
			allowLowerFallback: settings.allowLowerFallback,
		});
	}

	// 5. Download to temp (progress 25→65). Tidal arrives as a list of
	// fragmented-MP4 segments that must be concatenated and demuxed to FLAC;
	// every other provider serves a single URL.
	const tmpRaw = join(env.MUSIC_TMP_DIR, `job-${job.id}.raw`);
	await ctx.report(25, 'downloading');
	try {
		if (resolution.segments) {
			const { downloadTidalFlac } = await import('$lib/server/providers/tidal/download');
			const plan = resolution.segments;
			let lastPct = 25;
			const result = await downloadTidalFlac(plan, tmpRaw, {
				signal: ctx.signal,
				concurrency: Math.min(8, Math.max(2, settings.concurrentDownloads)),
				onProgress: (received, total) => {
					if (!total || total <= 0) return;
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
			// Compare the demuxed file's own STREAMINFO against the catalog
			// duration before anything is tagged or filed. This is what catches a
			// preview being served in place of a full-length track.
			const { verifyFlacIntegrity } = await import('$lib/server/library/integrity');
			const verdict = await verifyFlacIntegrity(tmpRaw, meta.durationSec);
			if (!verdict.ok) {
				await cleanupTemp(tmpRaw);
				throw new Error(`Downloaded audio failed integrity check — ${verdict.reason}`);
			}
			log.info('tidal segments assembled', {
				jobId: job.id,
				segments: plan.mediaUrls.length,
				bytes: result.bytes,
				bitDepth: result.streamInfo.bitDepth,
				sampleRateHz: result.streamInfo.sampleRateHz,
				actualSec:
					verdict.actualDurationSec != null
						? Number(verdict.actualDurationSec.toFixed(1))
						: null,
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
		lyricsSynced: null,
	};
	try {
		if (resolution.ext === 'flac') await tagFlac(finalTmp, tags);
		else tagMp3(finalTmp, tags);
	} catch (err) {
		// Tagging failure must not lose the audio; log and continue.
		log.warn('tagging failed, storing untagged file', { error: String(err) });
	}

	// 9. Lyrics BEFORE moving (sidecar lands next to audio path directly).
	// Fetch ONLY when the song misses lyrics or was just upgraded — never
	// re-hit dead APIs for sidecars that already exist on disk.
	await ctx.report(84, 'lyrics');
	const existingSidecar = await lyricsSidecar(meta);
	let lyrics: DownloadLyricsResult;
	if (upgradeForTrackId != null || existingSidecar == null) {
		lyrics = await downloadLyrics(meta);
	} else {
		log.info('lyrics fetch skipped — sidecar already present', {
			jobId: job.id,
			path: existingSidecar.path,
		});
		lyrics = {
			success: true,
			synced: existingSidecar.kind === 'synced',
			path: existingSidecar.path,
		};
	}

	// 10. Move into the library (Artist/Album/NN - Title.ext).
	await ctx.report(90, 'filing into library');
	const checksum = await sha256File(finalTmp);
	const audioRel = `${trackBaseRelativePath(meta)}.${resolution.ext}`;
	const finalPath = await moveIntoLibrary(finalTmp, audioRel);
	await cleanupTemp(finalTmp);

	// 10b. Embed the lyrics we just fetched (or found) INTO the file.
	//
	// The sidecar alone is invisible to Navidrome: it reads tags, not .lrc files,
	// so the dashboard showed lyrics while the player reported "No lyrics".
	// Re-tagging after the move is safe because the library path is already
	// final — the file no longer moves again, so writing it cannot desync the
	// DB row from disk. Best-effort: a failure here must not fail the download.
	if (lyrics.path) {
		try {
			const sidecarText = await readFile(lyrics.path, 'utf8');
			const withLyrics = {
				...tags,
				lyricsPlain: lyrics.synced ? stripLrcTimestamps(sidecarText) : sidecarText,
				lyricsSynced: lyrics.synced ? sidecarText : null,
			};
			if (resolution.ext === 'flac') await tagFlac(finalPath, withLyrics);
			else tagMp3(finalPath, withLyrics);
			log.info('lyrics embedded in file', {
				jobId: job.id,
				synced: lyrics.synced,
				bytes: sidecarText.length,
			});
		} catch (err) {
			log.warn('lyrics embedding failed, sidecar still present', { error: String(err) });
		}
	}

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
	const payload = job.payload as {
		repair?: boolean;
		full?: boolean;
		filesOnDisk?: number;
		tracksInDb?: number;
	};
	let retagged = 0;
	let tagsSkipped = 0;
	let tagsFailed = 0;
	let coversBackfilled = 0;
	let metadataRepairEnqueued = 0;
	if (payload.repair) {
		// Metadata repair FIRST: fill missing album/genre/year/ISRC and broken
		// covers from the catalog sources. Enqueued at high priority so it runs
		// ahead of the retag pass below, and each job force-retags its own file
		// — so the library converges whether or not the retag pass sees the
		// corrected rows in time.
		await updateProgress(job.id, job.type, job.trackId, 15, 'repairing missing metadata');
		const { listMetadataRepairCandidates } = await import('$lib/server/db/tracks');
		const { enqueueJob: enqueueRepair } = await import('./jobs');
		const metadataCandidates = await listMetadataRepairCandidates(200);
		for (const cand of metadataCandidates) {
			await enqueueRepair({
				type: 'metadata_repair',
				payload: { trackId: cand.id, reason: 'navidrome-repair' },
				trackId: cand.id,
				priority: 1,
			});
		}
		metadataRepairEnqueued = metadataCandidates.length;
		log.info('navidrome repair metadata pass enqueued', {
			candidates: metadataCandidates.length,
		});

		// Repair mode: rewrite embedded tags from canonical DB data BEFORE
		// scanning, so Navidrome indexes real artists/albums instead of
		// [Unknown]. Store FLACs often carry junk/empty Vorbis comments.
		await updateProgress(job.id, job.type, job.trackId, 20, 'repairing embedded tags');
		const { ensureFileTags } = await import('$lib/server/library/tagging');
		const { readFile } = await import('node:fs/promises');
		const { forceTagRepair } = await getSettings();
		for (const t of await listFiledTracks()) {
			if (!t.filePath) continue;
			// Prefer the .lrc: Navidrome reads no sidecars, so the lyrics only
			// become visible once embedded in the file's own tags.
			let lyricsPlain: string | null = null;
			let lyricsSynced: string | null = null;
			const base = t.filePath.replace(/\.(mp3|flac)$/i, '');
			const lrc = await readFile(`${base}.lrc`, 'utf8').catch(() => null);
			if (lrc) {
				lyricsSynced = lrc;
				lyricsPlain = stripLrcTimestamps(lrc);
			} else {
				const txt = await readFile(`${base}.txt`, 'utf8').catch(() => null);
				if (txt) lyricsPlain = txt;
			}
			const outcome = await ensureFileTags(
				t.filePath,
				{
					title: t.title,
					artist: t.artist,
					album: t.album,
					albumArtist: t.albumArtist,
					trackNumber: t.trackNumber,
					discNumber: t.discNumber,
					year: t.releaseYear,
					genre: t.genre,
					cover: null,
					lyricsPlain,
					lyricsSynced,
				},
				// Force is required to actually repair a whole library. The default
				// skips any file that already has a title+artist, which is exactly
				// the broken set: metaflac wrote `#CUT4####...` from a C-locale run,
				// and those files look tagged while holding mangled values, so the
				// pass reported success while changing nothing. Now a setting, so
				// routine scans stay cheap but a full re-tag can be forced by hand.
				{ force: forceTagRepair },
			);
			if (outcome === 'ok') retagged++;
			else if (outcome === 'skipped') tagsSkipped++;
			else tagsFailed++;
		}
		log.info('navidrome repair retag pass finished', {
			retagged,
			tagsSkipped,
			tagsFailed,
		});
		await updateProgress(
			job.id,
			job.type,
			job.trackId,
			35,
			`tags repaired (${retagged} fixed)`,
		);

		// Cover backfill: albums without Navidrome-recognized folder art get a
		// canonical cover.jpg (deduped variants like "cover (2).jpg" are
		// invisible to it).
		await updateProgress(job.id, job.type, job.trackId, 37, 'backfilling missing covers');
		const { backfillAlbumCovers } = await import('$lib/server/library/coverart');
		const coverReport = await backfillAlbumCovers(
			(await listFiledTracks()).map((t) => ({
				filePath: t.filePath,
				artist: t.artist,
				album: t.album,
			})),
		).catch((err) => {
			log.warn('cover backfill pass failed', { error: String(err) });
			return { checked: 0, backfilled: 0 };
		});
		coversBackfilled = coverReport.backfilled;
		log.info('navidrome repair cover pass finished', { ...coverReport });
	}
	await updateProgress(job.id, job.type, job.trackId, 40, 'triggering scan');
	// A repair exists because the index disagreed with the disk, so it always
	// asks for a FULL scan: an incremental one leaves the disagreement in place.
	const started = await startScan(s.navidromeUrl, s.navidromeUsername, s.navidromePassword, true);
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
		retagged,
	});
	return {
		status: 'ok',
		serverVersion: started.serverVersion,
		scanCompleted,
		lastScanCount: lastCount,
		stamped,
		retagged,
		coversBackfilled,
		metadataRepairEnqueued,
		filesOnDisk: payload.filesOnDisk ?? null,
		tracksInDb: payload.tracksInDb ?? null,
	};
}

/* ── metadata_repair ──────────────────────────────────────────────────────── */

/**
 * Fill gaps in a not-yet-persisted TrackMeta using the catalog sources. Used
 * on the download path so a track that lands with no album gets one before the
 * file is written. Never throws and never changes provider/stream identity.
 */
async function enrichInline(meta: TrackMeta): Promise<TrackMeta> {
	try {
		const { enrichTrackMetadata } = await import('$lib/server/metadata');
		const { neededFieldsFor } = await import('$lib/server/metadata/types');
		const needed = neededFieldsFor({
			album: meta.album,
			albumArtist: meta.albumArtist,
			coverPath: meta.coverUrl,
			genre: meta.genre,
			releaseYear: meta.year,
			trackNumber: meta.trackNumber,
			discNumber: meta.discNumber,
			isrc: meta.isrc,
		});
		if (needed.length === 0) return meta;
		const { patch } = await enrichTrackMetadata({
			trackId: '',
			title: meta.title,
			artist: meta.artist,
			album: meta.album,
			isrc: meta.isrc,
			durationSec: meta.durationSec,
			year: meta.year,
			needed,
		});
		if (Object.keys(patch).length === 0) return meta;
		return {
			...meta,
			album: patch.album ?? meta.album,
			albumArtist: patch.albumArtist ?? meta.albumArtist,
			coverUrl: patch.coverUrl ?? meta.coverUrl,
			genre: patch.genre ?? meta.genre,
			year: patch.year ?? meta.year,
			trackNumber: patch.trackNumber ?? meta.trackNumber,
			discNumber: patch.discNumber ?? meta.discNumber,
			isrc: patch.isrc ?? meta.isrc,
		};
	} catch (err) {
		log.debug('inline metadata enrichment skipped', { error: String(err) });
		return meta;
	}
}

/**
 * Fills a track's metadata gaps from the catalog sources (MusicBrainz, Apple
 * Music, Spotify, TIDAL, Qobuz) and repairs the library files it affects.
 *
 * Runs three passes, each independent so one failing source never blocks the
 * others:
 *   1. metadata  — missing album / album artist / genre / year / track no. / ISRC
 *   2. cover     — missing or broken cover art (also re-fetches known-bad ones)
 *   3. retag     — rewrites embedded tags + moves the file if the album changed
 *
 * All three are best-effort: the job succeeds and reports what it fixed.
 */
async function runMetadataRepair(job: JobRow, ctx: JobContext): Promise<Record<string, unknown>> {
	const payload = job.payload as {
		trackId?: string;
		reason?: string;
		force?: boolean;
		fields?: string[];
	};
	if (typeof payload.trackId !== 'string') throw new Error('metadata_repair missing trackId');
	const row = await getTrackById(payload.trackId);
	if (!row) throw new Error(`Track not found: ${payload.trackId}`);
	if (!row.filePath) {
		// Only filed rows are repairable — a failed download has nothing to fix.
		return { skipped: true, reason: 'no file on disk' };
	}

	const { enrichTrackMetadata, neededFieldsFor } = await import('$lib/server/metadata');
	const { ALL_FIELDS } = await import('$lib/server/metadata/types');
	const { fetchFirstImage } = await import('$lib/server/metadata/cover');
	const { applyMetadataPatch, setCoverPath, markMetadataStatus } = await import(
		'$lib/server/db/tracks'
	);
	const { coverRelativePath, trackBaseRelativePath } = await import('$lib/server/library/paths');

	const force = payload.force === true;
	const gapFields = neededFieldsFor({
		album: row.album,
		albumArtist: row.albumArtist,
		coverPath: row.coverPath,
		genre: row.genre,
		releaseYear: row.releaseYear,
		trackNumber: row.trackNumber,
		discNumber: row.discNumber,
		isrc: row.isrc,
		artistMbid: row.artistMbid,
	});

	// A FIELD-SCOPED forced pass: re-ask for these fields even when they are filled.
	//
	// `force: true` re-asks for everything, which is right once and wasteful
	// repeatedly. Genre needed exactly this: it was empty for every row because no
	// source implemented it, then a source was added — but the rows already
	// "verified" in a previous pass were never revisited, because genre was only
	// requested while it was missing. Asking for `['genre']` alone is one cheap
	// request per track instead of four, and cannot churn anything else.
	const requested = Array.isArray(payload.fields) ? payload.fields : null;
	const valid = requested?.filter((f): f is MetadataField =>
		(ALL_FIELDS as readonly string[]).includes(f),
	);
	const needed = valid && valid.length > 0 ? valid : gapFields;

	// ── 1. Metadata pass ────────────────────────────────────────────────────
	let patch: Awaited<ReturnType<typeof enrichTrackMetadata>>['patch'] = {};
	let filledBy: Record<string, string> = {};
	let tried: string[] = [];
	if (needed.length > 0) {
		await ctx.report(20, 'querying metadata sources');
		const result = await enrichTrackMetadata({
			trackId: row.id,
			title: row.title,
			artist: row.artist,
			album: row.album,
			isrc: row.isrc,
			durationSec: row.durationSec,
			year: row.releaseYear,
			needed,
		});
		patch = result.patch;
		filledBy = result.filledBy;
		tried = result.tried;
		if (Object.keys(patch).length > 0) {
			await applyMetadataPatch(row.id, patch);
			log.info('metadata repaired', {
				trackId: row.id,
				title: row.title,
				fields: Object.keys(patch).join(','),
				via: Object.values(filledBy).join(','),
			});
		}
	}

	// Effective metadata = patch wins over the stored row.
	const album = patch.album ?? row.album;
	const albumArtist = patch.albumArtist ?? row.albumArtist;
	const genre = patch.genre ?? row.genre;
	const year = patch.year ?? row.releaseYear;
	const trackNumber = patch.trackNumber ?? row.trackNumber;
	const discNumber = patch.discNumber ?? row.discNumber;
	const albumChanged = patch.album != null && patch.album !== row.album;

	// ── 2. Cover pass ───────────────────────────────────────────────────────
	await ctx.report(45, 'repairing cover art');
	let coverBytes: Buffer | null = null;
	const wantsCover = !row.coverPath || needed.includes('coverUrl');
	if (wantsCover) {
		// Try the source-provided artwork first, then a plain artist/album
		// search via the existing public Deezer helper.
		coverBytes = await fetchFirstImage([patch.coverUrl]);
		if (!coverBytes && album) {
			const { fetchAlbumArt } = await import('$lib/server/library/coverart');
			coverBytes = await fetchAlbumArt(row.artist, album);
		}
		if (coverBytes) {
			try {
				const { mkdir, writeFile } = await import('node:fs/promises');
				const relPath = coverRelativePath({
					title: row.title,
					artist: row.artist,
					album,
					trackNumber,
				});
				const dest = join(env.MUSIC_LIBRARY_DIR, relPath);
				await mkdir(join(dest, '..'), { recursive: true });
				await writeFile(dest, coverBytes);
				// Store the ABSOLUTE path: cover_path is stat()'d directly by the
				// cover route, so the relative form never resolved and left 88 rows
				// pointing at nothing.
				await setCoverPath(row.id, dest);
				log.info('cover repaired', {
					trackId: row.id,
					path: relPath,
					bytes: coverBytes.length,
				});
			} catch (err) {
				log.warn('cover write failed', { trackId: row.id, error: String(err) });
			}
		}
	}

	// ── 3. Retag + relocate ─────────────────────────────────────────────────
	let retagged = false;
	let movedTo: string | null = null;
	if (Object.keys(patch).length > 0 || coverBytes) {
		await ctx.report(70, 'rewriting embedded tags');
		const { ensureFileTags } = await import('$lib/server/library/tagging');
		let filePath = row.filePath;

		// An album discovered after the fact means the file sits in the wrong
		// folder (or "Unknown Album") — move it before tagging.
		if (albumChanged && album) {
			try {
				const { rename } = await import('node:fs/promises');
				const { existsSync } = await import('node:fs');
				const destRel = `${trackBaseRelativePath({
					title: row.title,
					artist: row.artist,
					album,
					trackNumber,
				})}.${filePath.split('.').pop()}`;
				const dest = join(env.MUSIC_LIBRARY_DIR, destRel);
				if (dest !== filePath && !existsSync(dest)) {
					const { mkdir } = await import('node:fs/promises');
					await mkdir(join(dest, '..'), { recursive: true });
					await rename(filePath, dest);
					const { updateTrackFilePath } = await import('$lib/server/db/tracks');
					await updateTrackFilePath(row.id, dest);
					filePath = dest;
					movedTo = destRel;
					log.info('track moved to corrected album folder', {
						trackId: row.id,
						dest: destRel,
					});
				}
			} catch (err) {
				log.warn('track relocate failed', { trackId: row.id, error: String(err) });
			}
		}

		const outcome = await ensureFileTags(
			filePath,
			{
				title: row.title,
				artist: row.artist,
				album,
				albumArtist,
				trackNumber,
				discNumber,
				year,
				genre,
				cover: coverBytes,
				lyricsPlain: null,
				lyricsSynced: null,
			},
			{ force: true },
		);
		retagged = outcome === 'ok';
	}

	// ── 4. Record the outcome ───────────────────────────────────────────────
	//
	// A reindex that changes nothing and a reindex that never ran must not look
	// alike, so each pass stamps a status the sweep can count. `corrected` is the
	// one that matters: it means a field the row already had was found to be wrong
	// and overwritten.
	const filledKeys = Object.keys(patch);
	const corrected = filledKeys.filter((k) => {
		const before = row[k as keyof typeof row];
		const after = patch[k as keyof typeof patch];
		return after != null && before != null && String(before) !== String(after);
	});
	const status =
		tried.length === 0 ? 'no-source' : corrected.length > 0 ? 'corrected' : 'verified';
	await markMetadataStatus(row.id, status);

	return {
		trackId: row.id,
		reason: payload.reason ?? 'sweep',
		forced: force,
		tried,
		filled: filledKeys,
		corrected,
		filledBy,
		status,
		coverFixed: coverBytes !== null,
		retagged,
		movedTo,
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
