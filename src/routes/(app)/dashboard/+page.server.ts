import { listJobs } from '$lib/server/queue/jobs';
import { listTracks, trackStats } from '$lib/server/db/tracks';
import { ensureMigrated } from '$lib/server/db';
import type { TrackDTO } from '$lib/shared/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	await ensureMigrated();
	const q = url.searchParams.get('q');
	const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);

	const [jobs, tracksResult, stats] = await Promise.all([
		listJobs(30),
		listTracks({ q: q ?? undefined, page: Number.isFinite(page) ? page : 1, pageSize: 50 }),
		trackStats(),
	]);

	const trackDtos: TrackDTO[] = tracksResult.items.map((t) => {
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
	});

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
		stats,
	};
};
