import { listJobs } from '$lib/server/queue/jobs';
import { listTracks, trackStats } from '$lib/server/db/tracks';
import { ensureMigrated } from '$lib/server/db';
import type { TrackDTO } from '$lib/shared/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	await ensureMigrated();
	const q = url.searchParams.get('q');
	const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);

	// 100 rows, not 30. The queue panel's badges were counting this window, so
	// "Active 30" really meant "30 of the 30 rows I was handed". The authoritative
	// totals are NOT returned from here: they arrive from /api/jobs, whose response
	// already carries `counts` and whose type generates correctly. Adding a field
	// to this loader produced a PageServerData that would not regenerate and came
	// through undefined at runtime, which showed as a confident 0.
	const [jobs, tracksResult, failedResult, stats] = await Promise.all([
		listJobs(30),
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
