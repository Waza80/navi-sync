import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { enqueueJob } from '$lib/server/queue/jobs';
import {
	findBestMatch,
	csvToPlaylist,
	type MatchCandidate,
} from '$lib/server/search/matcher';
import { getProvider } from '$lib/server/providers/registry';
import type { RequestHandler } from './$types';

const MAX_ROWS = 200;

/**
 * POST /api/playlist/import — Spotify-like CSV (or "Artist - Title" lines).
 * Every row is matched against the provider catalog with strict scoring
 * (title + artist + duration); only confident matches are enqueued — the
 * response reports unmatched rows with reasons instead of guessing.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return unauthorizedResponse();

	let csvText: string | null = null;
	const contentType = request.headers.get('content-type') ?? '';
	if (contentType.includes('multipart/form-data')) {
		const form = await request.formData().catch(() => null);
		const file = form?.get('file');
		if (file instanceof File) csvText = await file.text();
	} else {
		const body = (await request.json().catch(() => null)) as { csv?: string } | null;
		if (body && typeof body.csv === 'string') csvText = body.csv;
	}
	if (!csvText || csvText.trim().length === 0) {
		return badRequest(
			'Provide a CSV file (multipart "file") or {"csv": "..."} JSON.',
			'MISSING_CSV',
		);
	}

	const { entries } = csvToPlaylist(csvText, MAX_ROWS);
	if (entries.length === 0) {
		return badRequest(
			'No playable rows found. Expected Spotify-style headers (Track Name / Artist Name(s)) or "Artist - Title" lines.',
			'UNPARSEABLE',
		);
	}

	const deezer = getProvider('deezer');
	const matched: Array<{
		title: string;
		artist: string;
		providerTrackId: string;
		jobId: string;
	}> = [];
	const unmatched: Array<{ title: string; artist: string; reason: string }> = [];

	for (const entry of entries) {
		try {
			// Deezer exports carry exact ids — enqueue directly, no fuzzy match.
			if (entry.providerTrackId) {
				const job = await enqueueJob({
					type: 'download',
					payload: {
						url: `https://www.deezer.com/track/${entry.providerTrackId}`,
						provider: 'deezer',
					},
					createdBy: locals.user.id,
				});
				matched.push({
					title: entry.title,
					artist: entry.artist,
					providerTrackId: entry.providerTrackId,
					jobId: job.id,
				});
				continue;
			}

			// ISRC (Spotify exports): resolve the exact Deezer id via the public
			// API — precise, no guessing. Falls back to fuzzy search below.
			if (entry.isrc) {
				try {
					const res = await fetch(`https://api.deezer.com/track/isrc:${entry.isrc}`, {
						signal: AbortSignal.timeout(10_000),
					});
					const data = (await res.json()) as { id?: number | string; error?: unknown };
					if (data.id) {
						const job = await enqueueJob({
							type: 'download',
							payload: {
								url: `https://www.deezer.com/track/${data.id}`,
								provider: 'deezer',
							},
							createdBy: locals.user.id,
						});
						matched.push({
							title: entry.title,
							artist: entry.artist,
							providerTrackId: String(data.id),
							jobId: job.id,
						});
						continue;
					}
					unmatched.push({
						title: entry.title,
						artist: entry.artist,
						reason: 'ISRC not on Deezer',
					});
					continue;
				} catch {
					// fall through to fuzzy search
				}
			}

			const candidates = await deezer.search(`${entry.artist} ${entry.title}`);
			const pool: MatchCandidate[] = candidates.map((m) => ({
				title: m.title,
				artist: m.artist,
				album: m.album,
				durationSec: m.durationSec,
			}));
			const verdict = findBestMatch(
				{
					title: entry.title,
					artist: entry.artist,
					album: entry.album,
					durationSec: entry.durationSec,
				},
				pool,
			);
			const winner = verdict.candidate
				? candidates.find(
						(m) =>
							m.title === verdict.candidate?.title &&
							m.artist === verdict.candidate?.artist,
					)
				: undefined;
			if (!verdict.candidate || !winner) {
				unmatched.push({
					title: entry.title,
					artist: entry.artist,
					reason: verdict.reason,
				});
				continue;
			}
			const job = await enqueueJob({
				type: 'download',
				payload: {
					url:
						winner.sourceUrl ??
						`https://www.deezer.com/track/${winner.providerTrackId}`,
					provider: 'deezer',
				},
				createdBy: locals.user.id,
			});
			matched.push({
				title: winner.title,
				artist: winner.artist,
				providerTrackId: winner.providerTrackId,
				jobId: job.id,
			});
		} catch (err) {
			unmatched.push({
				title: entry.title,
				artist: entry.artist,
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return json({ matchedCount: matched.length, matched, unmatched, total: entries.length });
};
