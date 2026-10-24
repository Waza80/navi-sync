import { and, asc, count, desc, eq, ilike, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { trackRelativePath } from '$lib/server/library/paths';
import { jobs } from './schema';
import { db } from '$lib/server/db';
import { tracks } from '$lib/server/db/schema';
import type { TrackMeta, StreamResolution } from '$lib/server/providers/types';
import type { LyricsStatus } from '$lib/shared/types';
import type { ProbedQuality } from '$lib/server/library/tagging';
import { HIRES_MIN_SAMPLE_RATE_HZ } from '$lib/shared/quality';
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
	/** Measured sample rate; separates 24/44.1 from 24/96 and 24/192. */
	sampleRateHz: number | null;
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
				// Needed by the quality guardrail: without the rate a 24-bit file
				// cannot be told apart from a 24/96 one, and the guardrail compared
				// two of them as equals.
				sampleRateHz: tracks.sampleRateHz,
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
			sampleRateHz: tracks.sampleRateHz,
			isLossless: tracks.isLossless,
			filePath: tracks.filePath,
		})
		.from(tracks)
		.where(and(ilike(tracks.title, meta.title), ilike(tracks.artist, meta.artist)))
		.limit(1);
	return rows[0] ?? null;
}

/**
 * The row that owns a given on-disk file, if any.
 *
 * This is the lookup that makes "one file, one row" enforceable: a download
 * about to file audio must know whether some other row already claims that
 * exact path before it inserts a twin. Twin rows are how the delete button
 * becomes destructive — it removes the file for the row being deleted and
 * leaves the other pointing at nothing.
 */
export async function findTrackByFilePath(filePath: string): Promise<{
	id: string;
	provider: string;
	providerTrackId: string | null;
	filePath: string | null;
	downloadStatus: string;
} | null> {
	const [row] = await db
		.select({
			id: tracks.id,
			provider: tracks.provider,
			providerTrackId: tracks.providerTrackId,
			filePath: tracks.filePath,
			downloadStatus: tracks.downloadStatus,
		})
		.from(tracks)
		.where(eq(tracks.filePath, filePath))
		.limit(1);
	return row ?? null;
}

/** How many OTHER rows point at this path — the delete route's safety check. */
export async function countOtherTracksWithFilePath(
	filePath: string,
	excludeId: string,
): Promise<number> {
	const [row] = await db
		.select({ value: count() })
		.from(tracks)
		.where(and(eq(tracks.filePath, filePath), ne(tracks.id, excludeId)));
	return row?.value ?? 0;
}

/** The row for a provider track id, whatever its status. */
export async function findTrackByProvider(
	provider: string,
	providerTrackId: string,
): Promise<{ id: string; filePath: string | null } | null> {
	const [row] = await db
		.select({ id: tracks.id, filePath: tracks.filePath })
		.from(tracks)
		.where(and(eq(tracks.provider, provider), eq(tracks.providerTrackId, providerTrackId)))
		.limit(1);
	return row ?? null;
}

export interface UpsertTrackInput {
	meta: TrackMeta;
	resolution: StreamResolution | null;
	probed: ProbedQuality | null;
	filePath: string | null;
	coverPath: string | null;
	sizeBytes: number | null;
	checksumSha256: string | null;
	lyricsStatus: LyricsStatus;
	/** Source that produced the fetched copy (only when something was fetched). */
	lyricsSource?: string | null;
	/** Set only when the lyrics were written into the file in this same flow. */
	lyricsEmbeddedAt?: Date | null;
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
		recordingMbid: meta.recordingMbid,
		releaseMbid: meta.releaseMbid,
		releaseGroupMbid: meta.releaseGroupMbid,
		albumArtistMbid: meta.albumArtistMbid,
		releaseTrackMbid: meta.releaseTrackMbid,
		artistMbid: meta.artistMbid,
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
		// Absent means "this flow did not fetch anything", so keep the source
		// already recorded instead of blanking it on an upgrade.
		...(input.lyricsSource ? { lyricsSource: input.lyricsSource } : {}),
		// Only overwrite the marker when this flow embedded lyrics. A download
		// that fetched nothing must not clear an older embed.
		...(input.lyricsEmbeddedAt ? { lyricsEmbeddedAt: input.lyricsEmbeddedAt } : {}),
		// A track with a file on disk is completed; failed/pending rows have no file.
		...(input.filePath ? { downloadStatus: 'completed' as const } : {}),
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
	// Two preconditions, both required:
	//   - the shell must own no file_path, because a row that already points at real
	//     audio must keep pointing at it (overwriting orphans the file on disk); and
	//   - the (provider, provider_track_id) pair we are about to write must still be
	//     FREE. `tracks_provider_track_uq` is a unique index, and writing a taken
	//     pair into a different row is exactly the "Failed query: update tracks set
	//     provider = $1, provider_track_id = $2 …" failure uploads hit when the
	//     relocated track had already been fetched successfully by its new provider.
	//     In that case another row owns that identity, so the shell is left alone and
	//     the normal conflict-target upsert below updates the row that owns it.
	const existing = meta.isrc
		? await findExistingTrack(meta)
		: await findTrackByTitleArtist(meta.title, meta.artist);

	// One path, one row. If the file we just filed is already claimed by a
	// DIFFERENT row, that row IS the library entry for this audio — inserting a
	// twin would mean deleting either one removes a file the other still points
	// at. This is the backstop for the concurrent case the handler's pre-move
	// check cannot see: two jobs can both look before either writes.
	if (input.filePath) {
		const pathOwner = await findTrackByFilePath(input.filePath);
		if (pathOwner && pathOwner.id !== existing?.id) return pathOwner.id;
	}

	if (existing && existing.filePath === null) {
		const owner = await db
			.select({ id: tracks.id })
			.from(tracks)
			.where(
				and(
					eq(tracks.provider, meta.provider),
					eq(tracks.providerTrackId, meta.providerTrackId),
					ne(tracks.id, existing.id),
				),
			)
			.limit(1);
		if (!owner[0]) {
			await db.update(tracks).set(values).where(eq(tracks.id, existing.id));
			return existing.id;
		}
	}

	try {
		const rows = await db
			.insert(tracks)
			.values(values)
			.onConflictDoUpdate({
				target: [tracks.provider, tracks.providerTrackId],
				set: values,
			})
			.returning({ id: tracks.id });
		return rows[0].id;
	} catch (err) {
		// A concurrent job won the race and inserted the path owner between our
		// check and our insert. `tracks_file_path_uq` rejected the twin — return
		// the row that won instead of failing the job, because the audio is filed
		// and the recording IS in the library.
		if (input.filePath && String(err).includes('tracks_file_path_uq')) {
			const winner = await findTrackByFilePath(input.filePath);
			if (winner) return winner.id;
		}
		throw err;
	}
}

/**
 * Point the row that already owns a path at the bytes a download just produced.
 *
 * Used when a row claims a path whose file had gone missing and a fresh download
 * fills it back in. Only file-shaped fields are written — identity and text
 * metadata belong to the owner row and a later metadata pass owns correcting
 * them. The download's own metadata was applied to the temp file before the
 * move, so the bytes are correctly tagged regardless.
 */
export async function adoptDownloadedFile(input: {
	id: string;
	resolution: StreamResolution | null;
	probed: ProbedQuality | null;
	filePath: string;
	/** Only written when non-null: adoption must not blank an owner's cover. */
	coverPath?: string | null;
	sizeBytes: number | null;
	checksumSha256: string | null;
	/** Only written when provided: a failed fetch must not downgrade existing lyrics. */
	lyricsStatus?: LyricsStatus;
	lyricsSource?: string | null;
	lyricsEmbeddedAt?: Date | null;
}): Promise<void> {
	const set: Partial<typeof tracks.$inferInsert> = {
		filePath: input.filePath,
		sizeBytes: input.sizeBytes,
		checksumSha256: input.checksumSha256,
		format: input.probed?.container ?? input.resolution?.format ?? 'mp3',
		bitrateKbps: input.probed?.bitrateKbps ?? input.resolution?.claimedBitrateKbps ?? null,
		bitDepth: input.probed?.bitDepth ?? null,
		sampleRateHz: input.probed?.sampleRateHz ?? null,
		isLossless: input.probed?.lossless ?? input.resolution?.claimedLossless ?? false,
		downloadStatus: 'completed',
		updatedAt: new Date(),
	};
	// Only overwrite the measured duration when the probe actually reported one;
	// `undefined` here would have been written as NULL and blanked a known value.
	if (input.probed?.durationSec != null) set.durationSec = input.probed.durationSec;
	if (input.coverPath) set.coverPath = input.coverPath;
	if (input.lyricsStatus) set.lyricsStatus = input.lyricsStatus;
	if (input.lyricsSource) set.lyricsSource = input.lyricsSource;
	if (input.lyricsEmbeddedAt) set.lyricsEmbeddedAt = input.lyricsEmbeddedAt;
	await db.update(tracks).set(set).where(eq(tracks.id, input.id));
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
	/** Quality tier. Defaults to 'all'. */
	quality?: QualityTier;
}): Promise<TrackListResult> {
	const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 50));
	const page = Math.max(1, opts.page ?? 1);
	const scope = opts.scope ?? 'all';
	const quality = opts.quality ?? 'all';
	const conditions = [];
	if (opts.q) {
		const like = `%${opts.q}%`;
		conditions.push(
			or(ilike(tracks.title, like), ilike(tracks.artist, like), ilike(tracks.album, like)),
		);
	}
	// A row the user gave up on is not part of the library any more — they asked
	// for it to stop being refetched, so it should also stop being listed.
	conditions.push(eq(tracks.refetchBlocked, false));
	if (scope === 'filed') conditions.push(isNotNull(tracks.filePath));
	else if (scope === 'failed')
		conditions.push(and(eq(tracks.downloadStatus, 'failed'), isNull(tracks.filePath)));
	// Quality only means something for a row that has audio. Without this scope
	// the filter counted file-less failed rows as "lossy" and the counts on the
	// filter chips disagreed with the list they opened.
	if (quality !== 'all') {
		conditions.push(isNotNull(tracks.filePath));
		conditions.push(QUALITY_TIERS[quality]);
	}
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

/**
 * Quality tiers, as one place. The library filter, the stats panel and the bulk
 * upgrade all have to agree on what "hi-res" means, or the button count and the
 * filtered list disagree — which reads as a bug in one of them and is actually a
 * disagreement in three definitions.
 *
 * Deliberately expressed in SQL rather than derived from `qualityRank`, because
 * these run as COUNT/filter predicates over ~1300 rows and a TypeScript-side
 * classification would have to fetch every row first.
 */
export type QualityTier = 'all' | 'lossy' | 'cd16' | 'bit24' | 'hires';

export const QUALITY_TIERS: Record<Exclude<QualityTier, 'all'>, ReturnType<typeof sql>> = {
	// Anything lossy: MP3 at any bitrate, or a file whose container we could not
	// identify as lossless.
	lossy: sql`${tracks.isLossless} = false`,
	// Lossless at CD depth — the bulk of a well-kept library.
	cd16: sql`${tracks.isLossless} = true AND (${tracks.bitDepth} IS NULL OR ${tracks.bitDepth} < 24)`,
	// 24-bit but not hi-res: 24/44.1 and 24/48. A real tier, because these are
	// exactly the rows an upgrade sweep can still improve.
	bit24: sql`${tracks.isLossless} = true AND ${tracks.bitDepth} = 24 AND (${tracks.sampleRateHz} IS NULL OR ${tracks.sampleRateHz} <= ${HIRES_MIN_SAMPLE_RATE_HZ})`,
	// 24-bit above CD rate. An unknown rate is NOT counted: the badge would be a
	// claim the library cannot back.
	hires: sql`${tracks.isLossless} = true AND ${tracks.bitDepth} = 24 AND ${tracks.sampleRateHz} > ${HIRES_MIN_SAMPLE_RATE_HZ}`,
};

/** Reject anything that is not a known tier rather than silently showing all. */
export function parseQualityTier(v: string | null | undefined): QualityTier {
	return v === 'lossy' || v === 'cd16' || v === 'bit24' || v === 'hires' ? v : 'all';
}

export async function trackStats(): Promise<{
	total: number;
	lossless: number;
	withLyrics: number;
	failed: number;
	byQuality: Record<Exclude<QualityTier, 'all'>, number>;
	/** Rows the upgrade sweep could still improve — the number the button wants. */
	upgradeable: number;
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

	// Counts must sum to the filed library, so the scope here is exactly the one
	// the filter uses: real files, not the failed rows that carry no audio.
	const filed = and(eq(tracks.refetchBlocked, false), isNotNull(tracks.filePath));
	const tierCounts = await Promise.all(
		(Object.keys(QUALITY_TIERS) as Array<Exclude<QualityTier, 'all'>>).map(async (tier) => {
			const [row] = await db
				.select({ value: count() })
				.from(tracks)
				.where(and(filed, QUALITY_TIERS[tier]));
			return [tier, row?.value ?? 0] as const;
		}),
	);
	const byQuality = Object.fromEntries(tierCounts) as Record<Exclude<QualityTier, 'all'>, number>;

	// Mirrors `listUpgradeableTrackIds`' predicate EXACTLY — same below-the-ceiling
	// test, same completed/filed/unblocked conditions. Summing the tiers instead
	// looked equivalent and was not: a row with a file but a non-completed status
	// would have been counted on the button and then not enqueued, which reads as
	// a broken button rather than as two definitions that disagree.
	const [upgradeableRow] = await db
		.select({ value: count() })
		.from(tracks)
		.where(
			and(
				filed,
				eq(tracks.downloadStatus, 'completed'),
				sql`(${tracks.isLossless} = false OR ${tracks.bitDepth} IS NULL OR ${tracks.bitDepth} < 24 OR (${tracks.bitDepth} = 24 AND (${tracks.sampleRateHz} IS NULL OR ${tracks.sampleRateHz} <= ${HIRES_MIN_SAMPLE_RATE_HZ})))`,
			),
		);

	return {
		total: totalRow?.value ?? 0,
		lossless: losslessRow?.value ?? 0,
		withLyrics: lyricsRow?.value ?? 0,
		failed: failedRow?.value ?? 0,
		byQuality,
		upgradeable: upgradeableRow?.value ?? 0,
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
		coverPath: string | null;
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
			coverPath: tracks.coverPath,
		})
		.from(tracks)
		.where(isNotNull(tracks.filePath));
}

export async function updateLyricsStatus(
	id: string,
	status: LyricsStatus,
	/**
	 * Set when the lyrics have just been written into the audio file. Absent
	 * means "the status changed but nothing was embedded" — a failed fetch must
	 * not clear an older marker and enqueue the file again.
	 */
	embeddedAt?: Date,
	/** Source that produced the copy. Absent means "keep whatever was recorded". */
	source?: string,
): Promise<void> {
	await db
		.update(tracks)
		.set({
			lyricsStatus: status,
			updatedAt: new Date(),
			...(embeddedAt ? { lyricsEmbeddedAt: embeddedAt } : {}),
			...(source ? { lyricsSource: source } : {}),
		})
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
 * the top tier, (c) belong to the given provider.
 */
/**
 * Tracks below the top tier that are worth an upgrade attempt.
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
				sampleRateHz: tracks.sampleRateHz,
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
					// Anything that could still be better. This used to stop at
					// `bit_depth < 24`, which was the ceiling when 24-bit was one tier.
					// Now it also admits 24-bit files that are NOT hi-res — 24/44.1 and
					// 24/48 are three tiers below a 24/96 master, and a row sitting at one
					// of them is exactly the row an upgrade sweep exists to improve.
					// A 24-bit row with no recorded rate is included: the rate is unknown,
					// so whether it is already hi-res cannot be claimed.
					sql`(${tracks.isLossless} = false OR ${tracks.bitDepth} IS NULL OR ${tracks.bitDepth} < 24 OR (${tracks.bitDepth} = 24 AND (${tracks.sampleRateHz} IS NULL OR ${tracks.sampleRateHz} <= ${HIRES_MIN_SAMPLE_RATE_HZ})))`,
				),
			)
			// Least-recently-examined first. This was `created_at asc`, which with a
			// limit meant the same oldest rows were re-examined on every hourly run:
			// a track with no better master anywhere stayed in the window forever and
			// the backlog behind it never advanced. Widening the candidate set to
			// every 24-bit file would have made that starvation permanent rather than
			// latent, so the sweep now rotates through what it has already looked at.
			// `id` last, for a total order — see the note in listUpgradeableTrackIds.
			.orderBy(
				asc(sql`coalesce(${tracks.upgradeCheckedAt}, ${tracks.createdAt})`),
				asc(tracks.id),
			)
			.limit(limit)
	);
}

/**
 * Record that the upgrade engine has just examined a track.
 *
 * Best-effort and deliberately not awaited by the caller: it is sweep bookkeeping,
 * so a failure costs a repeated examination, never a missed upgrade.
 */
export async function markUpgradeChecked(trackId: string): Promise<void> {
	await db.update(tracks).set({ upgradeCheckedAt: new Date() }).where(eq(tracks.id, trackId));
}

/**
 * Track ids a "upgrade these" action should enqueue for.
 *
 * Three conditions, each with a specific reason to be there:
 *  - below the ceiling, using the SAME predicate as `listUpgradeCandidates`, so
 *    the button never queues a check for a track the sweep would refuse anyway;
 *  - only filed, completed, unblocked rows — a blocked row is one the user asked
 *    to leave alone, and a failed row has nothing to upgrade;
 *  - nothing already queued or running, so pressing the button twice does not
 *    double the provider traffic. The hourly sweep's cooldown is deliberately
 *    NOT consulted here: the user just asked, and that is the whole point.
 */
export async function listUpgradeableTrackIds(opts: {
	quality?: QualityTier;
	limit: number;
}): Promise<string[]> {
	const quality = opts.quality ?? 'all';
	// `hires` IS the ceiling: a filtered view of hi-res tracks has nothing to
	// upgrade. Falling through to the unfiltered predicate here would have made
	// "Upgrade" on the hi-res chip queue all 1262 rows below it — the exact
	// opposite of what the user asked, and invisible until the queue filled up.
	if (quality === 'hires') return [];
	const rows = await db
		.select({ id: tracks.id })
		.from(tracks)
		.where(
			and(
				eq(tracks.downloadStatus, 'completed'),
				eq(tracks.refetchBlocked, false),
				isNotNull(tracks.filePath),
				// Same "could still be better" test as the sweep.
				sql`(${tracks.isLossless} = false OR ${tracks.bitDepth} IS NULL OR ${tracks.bitDepth} < 24 OR (${tracks.bitDepth} = 24 AND (${tracks.sampleRateHz} IS NULL OR ${tracks.sampleRateHz} <= ${HIRES_MIN_SAMPLE_RATE_HZ})))`,
				quality !== 'all' ? QUALITY_TIERS[quality] : undefined,
				sql`NOT EXISTS (
					SELECT 1 FROM jobs j
					WHERE j.track_id = ${tracks.id}
					  AND j.type = 'upgrade_check'
					  AND j.status IN ('queued','running')
				)`,
			),
		)
		// Least-recently-examined first, so a bulk run works through the backlog in
		// the same fair order the hourly sweep uses.
		//
		// `id` is the final tiebreaker and is not decoration: bulk imports give
		// hundreds of rows the SAME created_at, and without a total order Postgres
		// is free to return those rows in a different order on a different query —
		// which is how "the first 25 of the sweep" silently stops being the first 25
		// of the same list the user was shown.
		.orderBy(
			asc(sql`coalesce(${tracks.upgradeCheckedAt}, ${tracks.createdAt})`),
			asc(tracks.id),
		)
		.limit(Math.max(1, Math.min(2000, opts.limit)));
	return rows.map((r) => r.id);
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
 * Rows that HAVE lyrics but have not written them into their audio file yet.
 *
 * This is the gap that made lyrics look broken: the fetch writes a sidecar and
 * sets `lyrics_status`, but nothing ever embedded it, and Navidrome's player
 * reads the tag, not the sidecar. The backfill is bounded by
 * `lyrics_embedded_at`, so the sweep drains instead of re-queueing the library
 * on every tick.
 *
 * The jobs-table guard caps retries at one per track per day: a row whose file
 * has vanished would otherwise be re-queued every five minutes forever.
 *
 * Plain rows come back after a day. The Navidrome player renders only entries
 * flagged `synced`, so a plain sidecar is still invisible there; the spec says to
 * keep asking until a synced version turns up, and the marker is what paces that.
 * A day — not a week — because the ordered traversal now actually reaches the
 * sources that carry synced copies (lrc.red, the fixed Deezer pipe), so the
 * remaining plain rows are few and a new synced upload should be picked up fast.
 */
export async function listLyricsEmbedCandidates(limit = 25): Promise<string[]> {
	const rows = await db
		.select({ id: tracks.id })
		.from(tracks)
		.where(
			and(
				isNotNull(tracks.filePath),
				sql`${tracks.lyricsStatus} IN ('synced','plain')`,
				sql`(
					${tracks.lyricsEmbeddedAt} IS NULL
					OR (${tracks.lyricsStatus} = 'plain'
					    AND ${tracks.lyricsEmbeddedAt} < now() - interval '1 day')
				)`,
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
		// Oldest first, so a stalled backfill cannot starve the tail of the queue.
		.orderBy(asc(tracks.updatedAt))
		.limit(limit);
	return rows.map((r) => r.id);
}

/**
 * Failed downloads stay VISIBLE: a placeholder row (no file) with
 * download_status='failed'. The retry sweep and the ⚡/↻ actions use it.
 */
export async function ensureFailedTrackRow(input: {
	provider: string;
	/**
	 * Validated as a real id, never a URL. This column is half the
	 * (provider, provider_track_id) unique key, so a URL here silently forks the
	 * row instead of matching the one that already owns the song.
	 */
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
	const { NOT_A_TRACK_ID } = await import('$lib/server/db/validate');
	const idCheck = NOT_A_TRACK_ID.safeParse(input.providerTrackId);
	if (!idCheck.success) {
		// Refuse rather than repair: a URL here used to create a duplicate row
		// titled "Failed download" that nothing could ever match or clean up.
		throw new Error(
			`ensureFailedTrackRow: providerTrackId must be a provider-native id, got ${JSON.stringify(input.providerTrackId)}`,
		);
	}
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
	// Never demote a row that still owns audio.
	//
	// This function upserts on (provider, provider_track_id), so when a FAILED
	// UPGRADE reports in, the conflict target matches the existing *completed* row
	// and the write below flipped it to `failed` with a null file_path. The song
	// was never lost — it is sitting on disk at 16-bit — but the library stopped
	// showing it, offered it for re-download, and could fetch a duplicate over the
	// top. A failed upgrade is an expected, silent outcome (the account may simply
	// not have the higher tier), so it must leave the existing row alone and only
	// record the reason.
	const existing = input.providerTrackId
		? await db
				.select({ id: tracks.id, filePath: tracks.filePath })
				.from(tracks)
				.where(
					and(
						eq(tracks.provider, input.provider),
						eq(tracks.providerTrackId, input.providerTrackId),
					),
				)
				.limit(1)
		: [];
	if (existing[0]?.filePath) {
		log.info('download failure ignored — track still has audio', {
			trackId: existing[0].id,
			error: input.error.slice(0, 120),
		});
		await logFailedDownload(input.error, existing[0].id);
		return existing[0].id;
	}

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

/** Permanently opt a track out of any further refetch attempt. */
export async function setRefetchBlocked(id: string, blocked: boolean): Promise<void> {
	await db
		.update(tracks)
		.set({ refetchBlocked: blocked, updatedAt: new Date() })
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
				// User-decided dead end: never retried by the sweep or the manual retry.
				eq(tracks.refetchBlocked, false),
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
			artistMbid: tracks.artistMbid,
			recordingMbid: tracks.recordingMbid,
			releaseMbid: tracks.releaseMbid,
			releaseGroupMbid: tracks.releaseGroupMbid,
			albumArtistMbid: tracks.albumArtistMbid,
			releaseTrackMbid: tracks.releaseTrackMbid,
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
					// Identity gaps are first-class gaps: a row with a perfect album
					// and cover but no recording MBID still cannot be linked to
					// MusicBrainz by any player.
					sql`${tracks.artistMbid} IS NULL`,
					sql`${tracks.recordingMbid} IS NULL`,
					sql`${tracks.releaseMbid} IS NULL`,
					sql`${tracks.releaseGroupMbid} IS NULL`,
					sql`${tracks.albumArtistMbid} IS NULL`,
					sql`${tracks.releaseTrackMbid} IS NULL`,
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
		artistMbid?: string | null;
		recordingMbid?: string | null;
		releaseMbid?: string | null;
		releaseGroupMbid?: string | null;
		albumArtistMbid?: string | null;
		releaseTrackMbid?: string | null;
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
	// Identity, not description: two artists can share a display name, so the
	// MusicBrainz id is what keeps them apart. The same applies to the recording,
	// release and release-group ids — none of them can be re-derived from the
	// names once MusicBrainz merges or redirects an entity.
	if (patch.artistMbid != null && patch.artistMbid.trim() !== '')
		set.artistMbid = patch.artistMbid;
	if (patch.recordingMbid != null && patch.recordingMbid.trim() !== '')
		set.recordingMbid = patch.recordingMbid;
	if (patch.releaseMbid != null && patch.releaseMbid.trim() !== '')
		set.releaseMbid = patch.releaseMbid;
	if (patch.releaseGroupMbid != null && patch.releaseGroupMbid.trim() !== '')
		set.releaseGroupMbid = patch.releaseGroupMbid;
	if (patch.albumArtistMbid != null && patch.albumArtistMbid.trim() !== '')
		set.albumArtistMbid = patch.albumArtistMbid;
	if (patch.releaseTrackMbid != null && patch.releaseTrackMbid.trim() !== '')
		set.releaseTrackMbid = patch.releaseTrackMbid;
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

/** The row for a recording, by exact ISRC. Used to fail the right row. */
/**
 * The row for a recording that is already in the library, however it got there.
 *
 * `findTrackByIsrc` only answers for an ISRC, so it misses a locally adopted
 * file — those rows carry provider `local` and often no ISRC at all. This also
 * matches on artist+album+title, which is what a provider's metadata resolves to
 * when the recording has no ISRC.
 *
 * Used to stop a failed download from inserting a SECOND row for a song that is
 * already present, which is what made adopted tracks appear as failed.
 */
export async function findTrackByIdentity(input: {
	title: string;
	artist: string;
	album: string | null;
	isrc: string | null;
	durationSec?: number | null;
}): Promise<{ id: string; provider: string } | null> {
	// An ISRC first: exact, when both sides have one.
	if (input.isrc) {
		const byIsrc = await findTrackByIsrc(input.isrc);
		if (byIsrc?.filePath != null) return { id: byIsrc.id, provider: 'isrc' };
	}

	// Then title + album + duration, and deliberately NOT artist.
	//
	// Artist is the one field that cannot be trusted to match. A locally uploaded
	// track carries the merged credit list — 'Ptite Soeur, neophron, FEMTOGO,
	// reivilose, prxpvne, rosaliedu38' — while the provider's metadata for the
	// same recording names one act. Requiring an artist match missed all seven
	// shadow rows this exists to prevent.
	//
	// Title + album + duration within a second is a far tighter key than any of
	// those three alone: two different songs on one album differing by title, or
	// sharing a title and differing by a full second of runtime, is not a thing
	// that happens.
	const rows = await db
		.select({
			id: tracks.id,
			provider: tracks.provider,
			filePath: tracks.filePath,
			durationSec: tracks.durationSec,
		})
		.from(tracks)
		.where(
			and(
				eq(tracks.title, input.title),
				input.album == null ? undefined : eq(tracks.album, input.album),
				input.durationSec == null ? undefined : eq(tracks.durationSec, input.durationSec),
			),
		)
		.limit(4);

	// Only a row that actually HAS a file counts. A previously failed row of the
	// same name must not shield a fresh failure from being recorded.
	const present = rows.find((r) => r.filePath != null);
	if (present) return { id: present.id, provider: present.provider };

	// Durations drift by a second after encoding, so retry the exact match with a
	// tolerance rather than demanding byte equality.
	if (input.durationSec != null) {
		const near = await db
			.select({
				id: tracks.id,
				provider: tracks.provider,
				filePath: tracks.filePath,
				durationSec: tracks.durationSec,
			})
			.from(tracks)
			.where(
				and(
					eq(tracks.title, input.title),
					input.album == null ? undefined : eq(tracks.album, input.album),
				),
			)
			.limit(8);
		const hit = near.find(
			(r) =>
				r.filePath != null &&
				Number(r.durationSec ?? -1) >= 0 &&
				Math.abs(Number(r.durationSec) - input.durationSec!) <= 1.5,
		);
		if (hit) return { id: hit.id, provider: hit.provider };
	}
	return null;
}

export async function findTrackByIsrc(
	isrc: string,
): Promise<{ id: string; title: string; filePath: string | null } | null> {
	const [row] = await db
		.select({
			id: tracks.id,
			title: tracks.title,
			filePath: tracks.filePath,
		})
		.from(tracks)
		.where(eq(tracks.isrc, isrc))
		.limit(1);
	return row ?? null;
}

/**
 * Stamp the outcome of a metadata pass on a row.
 *
 * `corrected` is the interesting one: it means a field the row ALREADY had was
 * found to be wrong and overwritten. Without this stamp a full reindex and a
 * no-op are indistinguishable, which is exactly what made wrong release years
 * sit unnoticed.
 */
export async function markMetadataStatus(
	id: string,
	status: 'corrected' | 'verified' | 'no-source',
): Promise<void> {
	await db
		.update(tracks)
		.set({ metadataStatus: status, metadataRefreshedAt: new Date(), updatedAt: new Date() })
		.where(eq(tracks.id, id));
}

/**
 * Filed rows eligible for a reindex pass, oldest refresh first.
 *
 * `limit` keeps one sweep bounded; the caller loops until it comes back empty.
 * Rows never refreshed sort first (NULLs first in ASC), so a library that has
 * never been indexed is fully covered before anything is re-done.
 */
export async function listReindexCandidates(limit = 50) {
	return db
		.select({
			id: tracks.id,
			title: tracks.title,
			artist: tracks.artist,
			metadataStatus: tracks.metadataStatus,
			metadataRefreshedAt: tracks.metadataRefreshedAt,
		})
		.from(tracks)
		.where(isNotNull(tracks.filePath))
		.orderBy(asc(tracks.metadataRefreshedAt), asc(tracks.id))
		.limit(limit);
}

/** Counts for the reindex status report, keyed by last pass outcome. */
export async function metadataReindexSummary() {
	const rows = await db
		.select({ status: tracks.metadataStatus, n: count() })
		.from(tracks)
		.where(isNotNull(tracks.filePath))
		.groupBy(tracks.metadataStatus);
	const byStatus: Record<string, number> = {};
	let refreshed = 0;
	for (const r of rows) {
		byStatus[r.status ?? 'never'] = Number(r.n);
		if (r.status != null) refreshed += Number(r.n);
	}
	const [total] = await db.select({ n: count() }).from(tracks).where(isNotNull(tracks.filePath));
	return { filedTracks: Number(total?.n ?? 0), refreshed, byStatus };
}

/**
 * Point a row at a new on-disk audio file. Used by metadata repair after a
 * discovered album forces the file into a different album folder.
 */
export async function updateTrackFilePath(id: string, filePath: string): Promise<void> {
	await db.update(tracks).set({ filePath, updatedAt: new Date() }).where(eq(tracks.id, id));
}

/**
 * Converge a row's album artist.
 *
 * Only ever called with a value agreed across the whole album, never a single
 * track's own credits — see `unifiedAlbumArtist` for why a per-track value is
 * the thing that splits one release into several Navidrome albums.
 */
export async function updateTrackAlbumArtist(id: string, albumArtist: string): Promise<void> {
	await db.update(tracks).set({ albumArtist, updatedAt: new Date() }).where(eq(tracks.id, id));
}

/**
 * Rewrite a row's text fields to their canonical form.
 *
 * Only ever called with values that are already NFC-normalised by the caller, and
 * only when they differ — the point is that the DATABASE must hold the same bytes
 * the tag writer produces. If the row keeps a non-canonical album while the file
 * is rewritten canonically, the next comparison disagrees forever and the file is
 * re-tagged on every single pass.
 */
export async function updateTrackTextFields(
	id: string,
	fields: {
		title?: string | null;
		artist?: string | null;
		album?: string | null;
		albumArtist?: string | null;
	},
): Promise<void> {
	const set: Record<string, unknown> = { updatedAt: new Date() };
	if (fields.title !== undefined) set.title = fields.title;
	if (fields.artist !== undefined) set.artist = fields.artist;
	if (fields.album !== undefined) set.album = fields.album;
	if (fields.albumArtist !== undefined) set.albumArtist = fields.albumArtist;
	await db.update(tracks).set(set).where(eq(tracks.id, id));
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
/**
 * Audio files on disk that NO row points at.
 *
 * The mirror image of `findOrphanedFiles`, and the one that was missing. Repair
 * could only ever see rows whose file exists; a file with no row at all was
 * invisible, so 13 unaccounted files reported "0 adopted" and the repair looked
 * broken rather than incomplete.
 */
export async function findUnindexedFiles(libraryDir: string): Promise<
	Array<{
		filePath: string;
		sizeBytes: number;
	}>
> {
	const rows = await db
		.select({ filePath: tracks.filePath })
		.from(tracks)
		.where(isNotNull(tracks.filePath));
	const known = new Set(rows.map((r) => r.filePath));

	const found: Array<{ filePath: string; sizeBytes: number }> = [];
	const walk = async (dir: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				await walk(full);
				continue;
			}
			if (!/\.(flac|mp3|wav|aiff|aif|m4a|ogg|opus)$/i.test(e.name)) continue;
			if (known.has(full)) continue;
			found.push({ filePath: full, sizeBytes: statSync(full).size });
		}
	};
	await walk(libraryDir);
	return found;
}

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
