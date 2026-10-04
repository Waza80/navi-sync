import { and, count, desc, eq, ilike, isNotNull, or, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { tracks } from '$lib/server/db/schema';
import type { TrackMeta, StreamResolution } from '$lib/server/providers/types';
import type { ProbedQuality } from '$lib/server/library/tagging';

export interface ExistingTrack {
	id: string;
	isrc: string | null;
	title: string;
	artist: string;
	format: string;
	bitrateKbps: number | null;
	bitDepth: number | null;
	isLossless: boolean;
}

/** 24-bit guardrail lookup: same ISRC (or title+artist when ISRC missing). */
export async function findExistingTrack(meta: TrackMeta): Promise<ExistingTrack | null> {
	if (meta.isrc) {
		const rows = await db
			.select({
				id: tracks.id,
				isrc: tracks.isrc,
				title: tracks.title,
				artist: tracks.artist,
				format: tracks.format,
				bitrateKbps: tracks.bitrateKbps,
				bitDepth: tracks.bitDepth,
				isLossless: tracks.isLossless,
			})
			.from(tracks)
			.where(eq(tracks.isrc, meta.isrc))
			.limit(1);
		if (rows[0]) return rows[0];
	}
	const rows = await db
		.select({
			id: tracks.id,
			isrc: tracks.isrc,
			title: tracks.title,
			artist: tracks.artist,
			format: tracks.format,
			bitrateKbps: tracks.bitrateKbps,
			bitDepth: tracks.bitDepth,
			isLossless: tracks.isLossless,
		})
		.from(tracks)
		.where(and(ilike(tracks.title, meta.title), ilike(tracks.artist, meta.artist)))
		.limit(1);
	return rows[0] ?? null;
}

export interface UpsertTrackInput {
	meta: TrackMeta;
	resolution: StreamResolution | null;
	probed: ProbedQuality | null;
	filePath: string | null;
	coverPath: string | null;
	sizeBytes: number | null;
	checksumSha256: string | null;
	lyricsStatus: 'none' | 'synced' | 'plain' | 'failed';
}

/** Insert or update the library row for a provider track (measured quality). */
export async function upsertTrack(input: UpsertTrackInput): Promise<string> {
	const { meta } = input;
	const values = {
		provider: meta.provider,
		providerTrackId: meta.providerTrackId,
		sourceUrl: meta.sourceUrl,
		title: meta.title,
		artist: meta.artist,
		album: meta.album,
		albumArtist: meta.albumArtist,
		isrc: meta.isrc,
		trackNumber: meta.trackNumber,
		discNumber: meta.discNumber,
		releaseYear: meta.year,
		genre: meta.genre,
		durationSec: input.probed?.durationSec ?? meta.durationSec,
		format: input.probed?.container ?? input.resolution?.format ?? 'mp3',
		bitrateKbps: input.probed?.bitrateKbps ?? input.resolution?.claimedBitrateKbps ?? null,
		bitDepth: input.probed?.bitDepth ?? null,
		sampleRateHz: input.probed?.sampleRateHz ?? null,
		isLossless: input.probed?.lossless ?? input.resolution?.claimedLossless ?? false,
		sizeBytes: input.sizeBytes,
		checksumSha256: input.checksumSha256,
		filePath: input.filePath,
		coverPath: input.coverPath,
		lyricsStatus: input.lyricsStatus,
		updatedAt: new Date(),
	};
	const rows = await db
		.insert(tracks)
		.values(values)
		.onConflictDoUpdate({
			target: [tracks.provider, tracks.providerTrackId],
			set: values,
		})
		.returning({ id: tracks.id });
	return rows[0].id;
}

export interface TrackListResult {
	items: Array<Record<string, unknown>>;
	total: number;
}

export async function listTracks(opts: {
	q?: string;
	page?: number;
	pageSize?: number;
}): Promise<TrackListResult> {
	const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 50));
	const page = Math.max(1, opts.page ?? 1);
	const filter = opts.q
		? or(
				ilike(tracks.title, `%${opts.q}%`),
				ilike(tracks.artist, `%${opts.q}%`),
				ilike(tracks.album, `%${opts.q}%`),
			)
		: undefined;

	const [{ value: total }] = await db.select({ value: count() }).from(tracks).where(filter);
	const items = await db
		.select()
		.from(tracks)
		.where(filter)
		.orderBy(desc(tracks.createdAt))
		.limit(pageSize)
		.offset((page - 1) * pageSize);
	return { items, total };
}

export async function getTrackById(id: string) {
	const rows = await db.select().from(tracks).where(eq(tracks.id, id)).limit(1);
	return rows[0] ?? null;
}

/** GDPR right to erasure: remove the DB row (files handled by caller). */
export async function deleteTrackRow(id: string): Promise<boolean> {
	const rows = await db.delete(tracks).where(eq(tracks.id, id)).returning({ id: tracks.id });
	return rows.length > 0;
}

export async function trackStats(): Promise<{
	total: number;
	lossless: number;
	withLyrics: number;
}> {
	const [totalRow] = await db.select({ value: count() }).from(tracks);
	const [losslessRow] = await db
		.select({ value: count() })
		.from(tracks)
		.where(eq(tracks.isLossless, true));
	const [lyricsRow] = await db
		.select({ value: count() })
		.from(tracks)
		.where(sql`${tracks.lyricsStatus} in ('synced','plain')`);
	return {
		total: totalRow?.value ?? 0,
		lossless: losslessRow?.value ?? 0,
		withLyrics: lyricsRow?.value ?? 0,
	};
}

export async function updateLyricsStatus(
	id: string,
	status: 'none' | 'synced' | 'plain' | 'failed',
): Promise<void> {
	await db
		.update(tracks)
		.set({ lyricsStatus: status, updatedAt: new Date() })
		.where(eq(tracks.id, id));
}

/**
 * Duplicate guard for uploads: a song (title+artist, case-insensitive) that
 * already has a file in the library must never appear twice. Returns the
 * existing row so the caller can reject/short-circuit the upload.
 */
export async function findLibraryDuplicate(
	title: string,
	artist: string,
): Promise<{ id: string; filePath: string | null } | null> {
	const rows = await db
		.select({ id: tracks.id, filePath: tracks.filePath })
		.from(tracks)
		.where(and(ilike(tracks.title, title), ilike(tracks.artist, artist)))
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Upgrade-sweep candidates: tracks that (a) have a real file, (b) sit below
 * the 24-bit ceiling, (c) belong to the given provider.
 */
export async function listUpgradeCandidates(providerId: string, limit = 10) {
	return db
		.select({
			id: tracks.id,
			provider: tracks.provider,
			providerTrackId: tracks.providerTrackId,
			title: tracks.title,
			artist: tracks.artist,
			album: tracks.album,
			isrc: tracks.isrc,
			sourceUrl: tracks.sourceUrl,
			format: tracks.format,
			bitrateKbps: tracks.bitrateKbps,
			bitDepth: tracks.bitDepth,
			isLossless: tracks.isLossless,
			durationSec: tracks.durationSec,
			year: tracks.releaseYear,
			genre: tracks.genre,
		})
		.from(tracks)
		.where(
			and(
				eq(tracks.provider, providerId),
				sql`(${tracks.isLossless} = false OR ${tracks.bitDepth} IS NULL OR ${tracks.bitDepth} < 24)`,
			),
		)
		.orderBy(desc(tracks.createdAt))
		.limit(limit);
}

/**
 * Lyrics backfill candidates: real files with no usable lyrics and no recent
 * lyrics attempt (jobs table rate-limits: a track whose last lyrics job
 * failed/dead-lettered within 24h is skipped).
 */
export async function listLyricsBackfillCandidates(limit = 5): Promise<
	Array<{
		id: string;
		title: string;
		artist: string;
		album: string | null;
		provider: string;
		providerTrackId: string | null;
		sourceUrl: string | null;
		durationSec: number | null;
	}>
> {
	return db
		.select({
			id: tracks.id,
			title: tracks.title,
			artist: tracks.artist,
			album: tracks.album,
			provider: tracks.provider,
			providerTrackId: tracks.providerTrackId,
			sourceUrl: tracks.sourceUrl,
			durationSec: tracks.durationSec,
		})
		.from(tracks)
		.where(
			and(
				sql`${tracks.filePath} IS NOT NULL`,
				sql`${tracks.lyricsStatus} IN ('failed','none')`,
				sql`NOT EXISTS (
					SELECT 1 FROM jobs j
					WHERE j.track_id = ${tracks.id}
					  AND j.type = 'lyrics'
					  AND j.status IN ('queued','running')
				)`,
				sql`NOT EXISTS (
					SELECT 1 FROM jobs j
					WHERE j.track_id = ${tracks.id}
					  AND j.type = 'lyrics'
					  AND j.status IN ('dead','succeeded')
					  AND j.created_at > now() - interval '24 hours'
				)`,
			),
		)
		.limit(limit);
}

/**
 * Failed downloads stay VISIBLE: a placeholder row (no file) with
 * download_status='failed'. The retry sweep and the ⚡/↻ actions use it.
 */
export async function ensureFailedTrackRow(input: {
	provider: string;
	providerTrackId: string | null;
	title: string;
	artist: string;
	album?: string | null;
	isrc?: string | null;
	coverUrl?: string | null;
	sourceUrl?: string | null;
	year?: number | null;
	durationSec?: number | null;
	trackNumber?: number | null;
	genre?: string | null;
	error: string;
}): Promise<string> {
	const values = {
		provider: input.provider,
		providerTrackId: input.providerTrackId,
		title: input.title,
		artist: input.artist,
		album: input.album ?? null,
		albumArtist: input.artist,
		isrc: input.isrc ?? null,
		trackNumber: input.trackNumber ?? null,
		releaseYear: input.year ?? null,
		genre: input.genre ?? null,
		durationSec: input.durationSec ?? null,
		format: 'unknown',
		filePath: null,
		coverPath: null,
		downloadStatus: 'failed' as const,
		updatedAt: new Date(),
	};
	const rows = await db
		.insert(tracks)
		.values(values)
		.onConflictDoUpdate({
			target: [tracks.provider, tracks.providerTrackId],
			set: { ...values, downloadStatus: 'failed' },
		})
		.returning({ id: tracks.id });
	await logFailedDownload(input.error, rows[0].id);
	return rows[0].id;
}

/** Last failure reason is kept in audit_log (redacted) for the UI tooltip. */
async function logFailedDownload(error: string, trackId: string): Promise<void> {
	const { auditLog } = await import('$lib/server/db/schema');
	await db
		.insert(auditLog)
		.values({
			event: 'download.failed',
			userId: null,
			metadata: { trackId, error: error.slice(0, 300) },
		})
		.catch(() => undefined);
}

export async function markDownloadStatus(
	id: string,
	status: 'completed' | 'failed' | 'pending',
): Promise<void> {
	await db
		.update(tracks)
		.set({ downloadStatus: status, updatedAt: new Date() })
		.where(eq(tracks.id, id));
}

/** Failed-download rows for the retry sweep (oldest first, 6h cooldown). */
export async function listFailedDownloadTracks(limit = 5): Promise<
	Array<{
		id: string;
		provider: string;
		providerTrackId: string | null;
		title: string;
		artist: string;
		sourceUrl: string | null;
	}>
> {
	return db
		.select({
			id: tracks.id,
			provider: tracks.provider,
			providerTrackId: tracks.providerTrackId,
			title: tracks.title,
			artist: tracks.artist,
			sourceUrl: tracks.sourceUrl,
		})
		.from(tracks)
		.where(
			and(
				eq(tracks.downloadStatus, 'failed'),
				sql`${tracks.updatedAt} < now() - interval '6 hours'`,
				sql`NOT EXISTS (
					SELECT 1 FROM jobs j
					WHERE j.track_id = ${tracks.id}
					  AND j.type = 'download'
					  AND j.status IN ('queued','running')
				)`,
			),
		)
		.orderBy(tracks.updatedAt)
		.limit(limit);
}

/** Number of library rows that point at a real file on disk. */
export async function countLibraryTracks(): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(tracks)
		.where(isNotNull(tracks.filePath));
	return row?.value ?? 0;
}

/**
 * Stamp every filed track as Navidrome-synced. Called after a repair scan
 * completes — Navidrome scans the whole folder, so per-track precision
 * would be false accuracy.
 */
export async function markLibrarySynced(): Promise<number> {
	const rows = await db
		.update(tracks)
		.set({ navidromeSyncedAt: new Date(), updatedAt: new Date() })
		.where(isNotNull(tracks.filePath))
		.returning({ id: tracks.id });
	return rows.length;
}
