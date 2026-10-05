import { and, asc, count, desc, eq, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { trackRelativePath } from '$lib/server/library/paths';
import { jobs } from './schema';
import { db } from '$lib/server/db';
import { tracks } from '$lib/server/db/schema';
import type { TrackMeta, StreamResolution } from '$lib/server/providers/types';
import type { ProbedQuality } from '$lib/server/library/tagging';
import { logger } from '$lib/server/logger';

const log = logger;

export interface ExistingTrack {
	id: string;
	/** Null when the row never downloaded anything and can be re-used. */
	filePath: string | null;
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
				filePath: tracks.filePath,
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
			filePath: tracks.filePath,
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
	// Reuse an existing shell before inserting.
	//
	// The conflict target is (provider, provider_track_id), which is right for a
	// straight re-download but wrong the moment a track MOVES between providers:
	// relocating a Deezer failure to Tidal changes both halves of the key, so the
	// insert matched nothing and every retry added another row for the same song
	// (measured: 47 duplicate groups covering 220 rows, eight rows for a single
	// track).
	//
	// Only a row with no file_path is reused. If the match already owns a file,
	// inserting is correct: that file is real audio, and overwriting the row would
	// orphan the file on disk. Those genuine multi-file cases are left to
	// `scripts/reconcile-duplicates.ts`, which never deletes audio.
	const existing = meta.isrc
		? await findExistingTrack(meta)
		: await findTrackByTitleArtist(meta.title, meta.artist);
	if (existing && existing.filePath === null) {
		await db.update(tracks).set(values).where(eq(tracks.id, existing.id));
		return existing.id;
	}

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

/** A row that never downloaded anything and can be safely re-used. */
async function findTrackByTitleArtist(
	title: string,
	artist: string,
): Promise<{ id: string; filePath: string | null } | null> {
	const rows = await db
		.select({ id: tracks.id, filePath: tracks.filePath })
		.from(tracks)
		.where(
			and(
				sql`lower(btrim(${tracks.title})) = lower(btrim(${title}))`,
				sql`lower(btrim(${tracks.artist})) = lower(btrim(${artist}))`,
			),
		)
		.limit(1);
	const r = rows[0];
	return r ? { id: r.id, filePath: r.filePath } : null;
}

export interface TrackListResult {
	items: Array<Record<string, unknown>>;
	total: number;
}

export async function listTracks(opts: {
	q?: string;
	page?: number;
	pageSize?: number;
	/** 'filed' = rows with a file (the actual library); 'failed' = file-less failed rows. */
	scope?: 'all' | 'filed' | 'failed';
}): Promise<TrackListResult> {
	const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 50));
	const page = Math.max(1, opts.page ?? 1);
	const scope = opts.scope ?? 'all';
	const conditions = [];
	if (opts.q) {
		const like = `%${opts.q}%`;
		conditions.push(
			or(ilike(tracks.title, like), ilike(tracks.artist, like), ilike(tracks.album, like)),
		);
	}
	if (scope === 'filed') conditions.push(isNotNull(tracks.filePath));
	else if (scope === 'failed')
		conditions.push(and(eq(tracks.downloadStatus, 'failed'), isNull(tracks.filePath)));
	const filter = conditions.length > 0 ? and(...conditions) : undefined;

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
	failed: number;
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
	const [failedRow] = await db
		.select({ value: count() })
		.from(tracks)
		.where(eq(tracks.downloadStatus, 'failed'));
	return {
		total: totalRow?.value ?? 0,
		lossless: losslessRow?.value ?? 0,
		withLyrics: lyricsRow?.value ?? 0,
		failed: failedRow?.value ?? 0,
	};
}

/** Every library row that points at a real file — the repair retag pass. */
export async function listFiledTracks(): Promise<
	Array<{
		id: string;
		filePath: string | null;
		title: string;
		artist: string;
		album: string | null;
		albumArtist: string | null;
		trackNumber: number | null;
		discNumber: number | null;
		releaseYear: number | null;
		genre: string | null;
	}>
> {
	return db
		.select({
			id: tracks.id,
			filePath: tracks.filePath,
			title: tracks.title,
			artist: tracks.artist,
			album: tracks.album,
			albumArtist: tracks.albumArtist,
			trackNumber: tracks.trackNumber,
			discNumber: tracks.discNumber,
			releaseYear: tracks.releaseYear,
			genre: tracks.genre,
		})
		.from(tracks)
		.where(isNotNull(tracks.filePath));
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
/**
 * Tracks below the 24-bit ceiling that are worth an upgrade attempt.
 *
 * `providerId` accepts `'*'` to mean EVERY provider — the sweep uses that,
 * because the point is cross-provider: the current provider may not have a
 * hi-res master while another does. The filter is applied in SQL (not by
 * fetching everything and filtering in JS) so the limit applies to real
 * candidates rather than to whichever rows happened to sort first.
 *
 * Only COMPLETED rows are considered: a track still queued or failed is the
 * retry sweep's business, and offering it an upgrade would duplicate work and
 * let a superseded file land on disk.
 */
export async function listUpgradeCandidates(providerId: string, limit = 10) {
	return (
		db
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
				filePath: tracks.filePath,
				durationSec: tracks.durationSec,
				year: tracks.releaseYear,
				genre: tracks.genre,
			})
			.from(tracks)
			.where(
				and(
					// `'*'` = any provider. Previously this compared the column to the
					// literal '*', which matched nothing — the sweep silently found zero
					// candidates and no track was ever upgraded.
					providerId === '*' ? undefined : eq(tracks.provider, providerId),
					eq(tracks.downloadStatus, 'completed'),
					sql`(${tracks.isLossless} = false OR ${tracks.bitDepth} IS NULL OR ${tracks.bitDepth} < 24)`,
				),
			)
			// Oldest-first: a track that has been waiting longest gets its attempt
			// first, so the sweep makes forward progress through the backlog.
			.orderBy(asc(tracks.createdAt))
			.limit(limit)
	);
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

/** Failed-download rows for the retry sweep (oldest first, 6h cooldown).
 * Pass `{ ignoreCooldown: true }` for the manual force-retry — the user
 * explicitly asked, so waiting is wrong.
 */
export async function listFailedDownloadTracks(
	limit = 5,
	opts: { ignoreCooldown?: boolean } = {},
): Promise<
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
				...(opts.ignoreCooldown
					? []
					: [sql`${tracks.updatedAt} < now() - interval '6 hours'`]),
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

/**
 * Metadata-repair candidates: filed rows with at least one gap worth filling —
 * no album (the "songs with no album" case), or no cover art, or missing
 * album-artist / genre / year / track number / ISRC.
 *
 * Ordered so the worst-off rows come first (no album, no cover), which is what
 * the user cares about. `limit` keeps each sweep pass bounded.
 */
export async function listMetadataRepairCandidates(limit = 25) {
	return db
		.select({
			id: tracks.id,
			title: tracks.title,
			artist: tracks.artist,
			album: tracks.album,
			albumArtist: tracks.albumArtist,
			coverPath: tracks.coverPath,
			genre: tracks.genre,
			releaseYear: tracks.releaseYear,
			trackNumber: tracks.trackNumber,
			discNumber: tracks.discNumber,
			isrc: tracks.isrc,
			durationSec: tracks.durationSec,
			filePath: tracks.filePath,
		})
		.from(tracks)
		.where(
			and(
				isNotNull(tracks.filePath),
				or(
					sql`${tracks.album} IS NULL OR btrim(${tracks.album}) = ''`,
					sql`${tracks.coverPath} IS NULL`,
					sql`${tracks.albumArtist} IS NULL`,
					sql`${tracks.genre} IS NULL`,
					sql`${tracks.releaseYear} IS NULL`,
				),
			),
		)
		.orderBy(
			// Rows missing an album rank above rows only missing a cover.
			sql`CASE WHEN ${tracks.album} IS NULL OR btrim(${tracks.album}) = '' THEN 0 ELSE 1 END`,
			asc(tracks.updatedAt),
		)
		.limit(limit);
}

/**
 * Apply an enrichment patch to a track row. Only non-empty values are written,
 * so an existing album/cover can never be blanked by a sparse source answer.
 * When `moveFile` is set and the album changed, the file is moved to its new
 * album folder so Navidrome sees the corrected grouping.
 */
export async function applyMetadataPatch(
	id: string,
	patch: {
		album?: string | null;
		albumArtist?: string | null;
		coverUrl?: string | null;
		genre?: string | null;
		year?: number | null;
		trackNumber?: number | null;
		discNumber?: number | null;
		isrc?: string | null;
	},
): Promise<boolean> {
	const set: Partial<typeof tracks.$inferInsert> = { updatedAt: new Date() };
	if (patch.album != null && patch.album.trim() !== '') set.album = patch.album;
	if (patch.albumArtist != null && patch.albumArtist.trim() !== '')
		set.albumArtist = patch.albumArtist;
	if (patch.genre != null && patch.genre.trim() !== '') set.genre = patch.genre;
	if (patch.year != null && Number.isFinite(patch.year)) set.releaseYear = patch.year;
	if (patch.trackNumber != null) set.trackNumber = patch.trackNumber;
	if (patch.discNumber != null) set.discNumber = patch.discNumber;
	if (patch.isrc != null && patch.isrc.trim() !== '') set.isrc = patch.isrc;
	// coverPath is written by the caller once the image is actually on disk.
	const rows = await db
		.update(tracks)
		.set(set)
		.where(eq(tracks.id, id))
		.returning({ id: tracks.id });
	return rows.length > 0;
}

/** Record the on-disk cover path after a cover image is written. */
export async function setCoverPath(id: string, coverPath: string | null): Promise<void> {
	await db.update(tracks).set({ coverPath, updatedAt: new Date() }).where(eq(tracks.id, id));
}

/**
 * Point a row at a new on-disk audio file. Used by metadata repair after a
 * discovered album forces the file into a different album folder.
 */
export async function updateTrackFilePath(id: string, filePath: string): Promise<void> {
	await db.update(tracks).set({ filePath, updatedAt: new Date() }).where(eq(tracks.id, id));
}

/** Rows whose album cover is missing or points at a file that no longer exists. */
export async function listBrokenCoverCandidates(limit = 25) {
	return db
		.select({
			id: tracks.id,
			title: tracks.title,
			artist: tracks.artist,
			album: tracks.album,
			coverPath: tracks.coverPath,
			filePath: tracks.filePath,
		})
		.from(tracks)
		.where(and(isNotNull(tracks.filePath), sql`${tracks.coverPath} IS NULL`))
		.orderBy(asc(tracks.updatedAt))
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

/**
 * Rows this server owns (filePath under its library dir) whose audio file
 * is gone from disk — the "song isn't there but shows completed" case.
 * Scoped to our own library dir on purpose: with several servers sharing
 * one DB, each server may only judge paths it can actually see.
 */
export async function findMissingFiles(
	libraryDir: string,
): Promise<Array<{ id: string; title: string; artist: string; filePath: string }>> {
	const prefix = libraryDir.endsWith('/') ? libraryDir : `${libraryDir}/`;
	const rows = await db
		.select({
			id: tracks.id,
			title: tracks.title,
			artist: tracks.artist,
			filePath: tracks.filePath,
		})
		.from(tracks)
		.where(
			and(
				eq(tracks.downloadStatus, 'completed'),
				isNotNull(tracks.filePath),
				sql`${tracks.filePath} LIKE ${`${prefix}%`}`,
			),
		);
	return rows.filter(
		(r): r is { id: string; title: string; artist: string; filePath: string } =>
			typeof r.filePath === 'string' && !existsSync(r.filePath),
	);
}

/**
 * The inverse of `findMissingFiles`: failed/pending rows whose audio is actually
 * still on disk.
 *
 * A retry marks a row `failed` the moment a download attempt gives up, but it
 * does not delete the file — so a track that downloaded successfully once and
 * later failed an *upgrade* keeps its audio while its row claims to have none.
 * Those rows then show up in the UI as missing, get offered for re-download, and
 * can be re-fetched into a duplicate. So when reconciling, look for the file the
 * metadata says should exist and adopt it if it does.
 *
 * Only rows with no `file_path` are considered: if one is set, `findMissingFiles`
 * already owns the decision.
 */
export async function findOrphanedFiles(libraryDir: string): Promise<
	Array<{
		id: string;
		title: string;
		artist: string;
		filePath: string;
		sizeBytes: number;
	}>
> {
	const { readdirSync } = await import('node:fs');
	const rows = await db
		.select({
			id: tracks.id,
			title: tracks.title,
			artist: tracks.artist,
			album: tracks.album,
			albumArtist: tracks.albumArtist,
			trackNumber: tracks.trackNumber,
			discNumber: tracks.discNumber,
		})
		.from(tracks)
		.where(
			and(
				sql`${tracks.downloadStatus} IN ('failed','pending')`,
				isNull(tracks.filePath),
				isNotNull(tracks.album),
			),
		);

	/** Comparable form of a filename: no track prefix, no "(2)" dedup suffix. */
	const stem = (name: string): string =>
		name
			.replace(/\.[^.]+$/, '')
			.replace(/^\s*\d{1,3}\s*[-._)\]]*\s+/, '')
			.replace(/\s*\(\d+\)\s*$/, '')
			.normalize('NFD')
			.replace(/\p{Diacritic}/gu, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '')
			.trim();

	// One directory listing per album, reused across its tracks.
	const dirCache = new Map<string, Array<{ name: string; path: string; size: number }>>();
	const out: Array<{
		id: string;
		title: string;
		artist: string;
		filePath: string;
		sizeBytes: number;
	}> = [];
	const claimed = new Set<string>();

	for (const r of rows) {
		const meta = {
			title: r.title,
			artist: r.artist,
			album: r.album,
			albumArtist: r.albumArtist ?? r.artist,
			trackNumber: r.trackNumber,
			discNumber: r.discNumber,
		};
		// The album folder is reliable (artist + album are both known), but the
		// FILENAME is not: a row that failed before numbering was resolved has
		// track_number = NULL, which would derive `00 - Title.flac` and match
		// nothing. So resolve the folder, then match the title against what is
		// actually in it.
		const dir = join(
			libraryDir,
			trackRelativePath(meta, 'flac').split('/').slice(0, -1).join('/'),
		);
		let entries = dirCache.get(dir);
		if (!entries) {
			// A row can name an album folder that does not exist on disk (the
			// download never got that far), so a missing directory is expected
			// rather than exceptional.
			let listing: Array<{ name: string; path: string; size: number }> = [];
			try {
				listing = readdirSync(dir, { withFileTypes: true })
					.filter((e) => e.isFile() && /\.(flac|mp3)$/i.test(e.name))
					.map((e) => {
						const p = join(dir, e.name);
						return {
							name: e.name,
							path: p,
							size: statSync(p, { throwIfNoEntry: false })?.size ?? 0,
						};
					})
					.filter((e) => e.size > 0);
			} catch {
				listing = [];
			}
			entries = listing;
			dirCache.set(dir, entries);
		}
		if (entries.length === 0) continue;

		const wanted = stem(r.title);
		if (!wanted) continue;
		const match =
			// Prefer an exact numbered match when the row does know its number.
			(r.trackNumber != null
				? entries.find(
						(e) =>
							e.name.startsWith(`${String(r.trackNumber).padStart(2, '0')} - `) &&
							stem(e.name) === wanted,
					)
				: undefined) ??
			entries.find((e) => stem(e.name) === wanted && !claimed.has(e.path));
		if (!match || claimed.has(match.path)) continue;
		claimed.add(match.path);
		out.push({
			id: r.id,
			title: r.title,
			artist: r.artist,
			filePath: match.path,
			sizeBytes: match.size,
		});
	}
	return out;
}

/**
 * Adopt a file that is already on disk for a row that lost its `file_path`.
 *
 * Re-probes real audio properties rather than trusting the row, so quality,
 * bitrate and losslessness describe the bytes that are actually there — the same
 * reason the download path probes after tagging.
 */
export async function adoptExistingFile(
	id: string,
	filePath: string,
	sizeBytes: number,
): Promise<boolean> {
	try {
		const { probeQuality, ensureFileTags } = await import('$lib/server/library/tagging');
		const row = await db
			.select({
				title: tracks.title,
				artist: tracks.artist,
				album: tracks.album,
				albumArtist: tracks.albumArtist,
				trackNumber: tracks.trackNumber,
				discNumber: tracks.discNumber,
				releaseYear: tracks.releaseYear,
				genre: tracks.genre,
			})
			.from(tracks)
			.where(eq(tracks.id, id))
			.limit(1);
		const r = row[0];
		if (!r) return false;

		// Re-tag from canonical data so an adopted file is not left with whatever
		// half-written state the failed attempt left behind.
		await ensureFileTags(
			filePath,
			{
				title: r.title,
				artist: r.artist,
				album: r.album,
				albumArtist: r.albumArtist,
				trackNumber: r.trackNumber,
				discNumber: r.discNumber,
				year: r.releaseYear,
				genre: r.genre,
				cover: null,
				lyricsPlain: null,
				lyricsSynced: null,
			},
			{ force: true },
		);

		const probed = await probeQuality(filePath).catch(() => null);
		await db
			.update(tracks)
			.set({
				filePath,
				sizeBytes,
				downloadStatus: 'completed',
				...(probed
					? {
							format: probed.container,
							bitrateKbps: probed.bitrateKbps,
							bitDepth: probed.bitDepth,
							sampleRateHz: probed.sampleRateHz,
							isLossless: probed.lossless,
							durationSec: probed.durationSec,
						}
					: {}),
				updatedAt: new Date(),
			})
			.where(eq(tracks.id, id));
		return true;
	} catch (err) {
		log.warn('adopting on-disk file failed', { id, filePath, error: String(err) });
		return false;
	}
}

/**
 * Materialize failed rows for dead download jobs that never got one (e.g.
 * jobs that died before failed rows existed, or whose history was cleared).
 * Links each job to its row so repeat runs never duplicate.
 */
export async function reconcileDeadJobs(
	limit = 200,
): Promise<{ materialized: number; marked: number }> {
	const dead = await db
		.select({ id: jobs.id, trackId: jobs.trackId, payload: jobs.payload, error: jobs.error })
		.from(jobs)
		.where(and(eq(jobs.type, 'download'), eq(jobs.status, 'dead')))
		.orderBy(desc(jobs.createdAt))
		.limit(limit);
	let materialized = 0;
	let marked = 0;
	for (const job of dead) {
		const payload = (job.payload ?? {}) as Record<string, unknown>;
		const meta = (payload['meta'] ?? {}) as Record<string, unknown>;
		const url = typeof payload['url'] === 'string' ? payload['url'] : null;
		const provider = typeof payload['provider'] === 'string' ? payload['provider'] : 'unknown';
		if (job.trackId) {
			const row = await getTrackById(job.trackId);
			if (row) {
				const fp = row.filePath;
				if (typeof fp !== 'string' || !existsSync(fp)) {
					await markDownloadStatus(job.trackId, 'failed');
					marked++;
				}
				continue;
			}
		}
		const title =
			typeof meta['title'] === 'string' && meta['title'].length > 0
				? meta['title']
				: 'Failed download';
		const artist =
			typeof meta['artist'] === 'string' && meta['artist'].length > 0
				? meta['artist']
				: 'Unknown Artist';
		const newId = await ensureFailedTrackRow({
			provider,
			providerTrackId: url,
			title,
			artist,
			album: typeof meta['album'] === 'string' ? meta['album'] : null,
			sourceUrl: url,
			error: typeof job.error === 'string' ? job.error : 'dead job',
		});
		await db.update(jobs).set({ trackId: newId }).where(eq(jobs.id, job.id));
		materialized++;
	}
	return { materialized, marked };
}
