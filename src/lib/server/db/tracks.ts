import { and, count, desc, eq, ilike, or, sql } from 'drizzle-orm';
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
