import { jobCounts, listJobs } from '$lib/server/queue/jobs';
import { listTracks, trackStats } from '$lib/server/db/tracks';
import { ensureMigrated } from '$lib/server/db';
import type { TrackDTO } from '$lib/shared/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	await ensureMigrated();
	const q = url.searchParams.get('q');
	const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);

	// 100 rows, not 30, and `jobCounts` counted over the whole table.
	//
	// The queue panel's badges were computed by counting the returned window, so
	// "Active 30" was really "30 of the 30 rows I was handed". The counts are now
	// a separate query against the real table, which is the only way the number can
	// survive the window being a window.
	const [jobs, counts, tracksResult, failedResult, stats] = await Promise.all([
		listJobs(100),
		jobCounts(),
		listTracks({
			q: q ?? undefined,
			page: Number.isFinite(page) ? page : 1,
			pageSize: 50,
			scope: 'filed',
		}),
		listTracks({ pageSize: 100, scope: 'failed' }),
		trackStats(),
	]);

	const toDto = (t: (typeof tracksResult.items)[number]): TrackDTO => {
		const row = t as {
			id: string;
			provider: string;
			title: string;
			artist: string;
			album: string | null;
			isrc: string | null;
			trackNumber: number | null;
			releaseYear: number | null;
			durationSec: number | null;
			format: string;
			bitrateKbps: number | null;
			bitDepth: number | null;
			sampleRateHz: number | null;
			isLossless: boolean;
			sizeBytes: number | null;
			lyricsStatus: string;
			downloadStatus: string;
			createdAt: Date;
		};
		return {
			id: row.id,
			provider: row.provider,
			title: row.title,
			artist: row.artist,
			album: row.album,
			isrc: row.isrc,
			trackNumber: row.trackNumber,
			releaseYear: row.releaseYear,
			durationSec: row.durationSec,
			format: row.format,
			bitrateKbps: row.bitrateKbps,
			bitDepth: row.bitDepth,
			sampleRateHz: row.sampleRateHz,
			isLossless: row.isLossless,
			sizeBytes: row.sizeBytes,
			lyricsStatus: (row.lyricsStatus as TrackDTO['lyricsStatus']) ?? 'none',
			downloadStatus: (row.downloadStatus as TrackDTO['downloadStatus']) ?? 'completed',
			createdAt: row.createdAt.toISOString(),
		};
	};
	const trackDtos: TrackDTO[] = tracksResult.items.map(toDto);
	const failedDtos: TrackDTO[] = failedResult.items.map(toDto);

	return {
		jobCounts: counts,
		jobs: jobs.map((j) => ({
			id: j.id,
			type: j.type,
			status: j.status,
			priority: j.priority,
			progress: j.progress,
			stage: j.stage,
			error: j.error,
			attempts: j.attempts,
			maxAttempts: j.maxAttempts,
			trackId: j.trackId,
			createdAt: j.createdAt.toISOString(),
			finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
		})),
		tracks: trackDtos,
		tracksTotal: tracksResult.total,
		failedTracks: failedDtos,
		failedTotal: failedResult.total,
		stats,
	};
};
