import { jobCounts, listJobs } from '$lib/server/queue/jobs';
import { listTracks, trackStats } from '$lib/server/db/tracks';
import { ensureMigrated } from '$lib/server/db';
import type { TrackDTO } from '$lib/shared/types';
import type { PageServerLoad } from './$types';
import { logger } from '$lib/server/logger';

export const load: PageServerLoad = async ({ url }) => {
	// A failed migration must not blank the page either — the library is readable
	// even if a migration is pending, and /api/health reports the real state.
	await ensureMigrated().catch((err: unknown) => {
		logger.warn('ensureMigrated failed on dashboard load', { error: String(err) });
	});
	const q = url.searchParams.get('q');
	const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);

	// 100 rows, not 30. The queue panel's badges were counting this window, so
	// "Active 30" really meant "30 of the 30 rows I was handed". The authoritative
	// totals are NOT returned from here: they arrive from /api/jobs, whose response
	// already carries `counts` and whose type generates correctly. Adding a field
	// to this loader produced a PageServerData that would not regenerate and came
	// through undefined at runtime, which showed as a confident 0.
	// Counts come from the SERVER, on every load. The client store is only an
	// enhancement on top of this: it is seeded from here and kept live by SSE
	// deltas. When the two disagree, this one is right — the store has now been
	// wrong three times (never subscribed, non-reactive field, never started).
	// Each panel degrades on its own. `Promise.all` meant a single rejection — one
	// dropped Postgres connection while a repair was rewriting rows, or a slow
	// `jobCounts` over a table that had just grown past a thousand jobs — rejected
	// the whole load, the reverse proxy reported 502, and the entire library page
	// rendered blank. The queue is a panel, not the page: losing it must cost the
	// queue panel and nothing else.
	//
	// `settle` reports which panels came back empty so the UI can say so rather
	// than showing confident zeros.
	type Panels = {
		jobs: Awaited<ReturnType<typeof listJobs>>;
		counts: Awaited<ReturnType<typeof jobCounts>>;
		tracks: Awaited<ReturnType<typeof listTracks>>;
		failed: Awaited<ReturnType<typeof listTracks>>;
		stats: Awaited<ReturnType<typeof trackStats>>;
	};
	const EMPTY_TRACKS = { items: [], total: 0 } as Panels['tracks'];
	const settle = async <T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> => {
		try {
			return await run();
		} catch (err) {
			logger.warn('dashboard panel unavailable', { panel: what, error: String(err) });
			degraded.push(what);
			return fallback;
		}
	};
	const degraded: string[] = [];

	const [jobs, counts, tracksResult, failedResult, stats] = await Promise.all([
		settle('jobs', () => listJobs(30), [] as Panels['jobs']),
		settle('counts', () => jobCounts(), { total: 0, active: 0, byStatus: {} }),
		settle(
			'tracks',
			() =>
				listTracks({
					q: q ?? undefined,
					page: Number.isFinite(page) ? page : 1,
					pageSize: 50,
					scope: 'filed',
				}),
			EMPTY_TRACKS,
		),
		settle('failed', () => listTracks({ pageSize: 100, scope: 'failed' }), EMPTY_TRACKS),
		settle('stats', () => trackStats(), { total: 0, lossless: 0, withLyrics: 0, failed: 0 }),
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
			refetchBlocked: boolean;
			filePath: string | null;
			albumArtist: string | null;
			genre: string | null;
			coverPath: string | null;
			metadataStatus: string | null;
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
			// Was missing, so TrackCard read `undefined` forever: the block button
			// never flipped to its "resume" state and every click therefore sent the
			// same `blocked: true`. Blocking DID work — listTracks excludes blocked
			// rows from every scope, so the row left the failed list — but with no
			// visible state change the button looked dead.
			refetchBlocked: row.refetchBlocked,
			filePath: row.filePath,
			albumArtist: row.albumArtist,
			genre: row.genre,
			coverPath: row.coverPath,
			metadataStatus: row.metadataStatus,
			createdAt: row.createdAt.toISOString(),
		};
	};
	const trackDtos: TrackDTO[] = tracksResult.items.map(toDto);
	const failedDtos: TrackDTO[] = failedResult.items.map(toDto);

	return {
		/** Panels that failed to load, so the UI can say so instead of showing zeros. */
		degradedPanels: degraded,
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
