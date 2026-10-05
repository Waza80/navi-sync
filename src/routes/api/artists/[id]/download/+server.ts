import { z } from 'zod';
import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { enqueueJob } from '$lib/server/queue/jobs';
import { getProvider } from '$lib/server/providers/registry';
import { enabledProviders } from '$lib/server/providers/enabled';
import { trackPageUrl } from '$lib/server/providers/ids';
import { logger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = logger;
const idSchema = z.string().min(1).max(100);

/**
 * POST /api/artists/:id/download — fan out everything by an artist.
 *
 * Artist -> albums -> tracks. Album ids are provider-scoped, so `?provider=` picks
 * the provider the artist link came from; it defaults to whichever enabled
 * provider can expand artists.
 *
 * Two caps keep this from queueing thousands of jobs: `maxAlbums` (default 25)
 * and a hard ceiling on tracks. Both are reported back so the UI can say what was
 * skipped rather than silently truncating.
 */
export const POST: RequestHandler = async ({ locals, params, url }) => {
	if (!locals.user) return unauthorizedResponse();
	const artistId = params.id ?? '';
	if (!idSchema.safeParse(artistId).success) {
		return badRequest('Invalid artist id', 'INVALID_ID');
	}

	// Defaults cover a full artist: Tanger has 67 albums and the Deezer API ranks
	// all of them, so a 25-album default silently truncated "download everything by
	// X" to a third of the catalogue. Ceilings still exist to bound a pathological
	// catalogue, and `truncated` reports when they bite.
	const maxAlbums = Math.min(
		500,
		Math.max(1, Number(url.searchParams.get('maxAlbums') ?? 100) || 100),
	);
	const maxTracks = Math.min(
		2000,
		Math.max(1, Number(url.searchParams.get('maxTracks') ?? 1500) || 1500),
	);
	const preferred = url.searchParams.get('provider') ?? undefined;

	const enabled = new Set((await enabledProviders()).map((p) => p.id));
	const candidates = (await import('$lib/server/providers/registry')).providers.filter(
		(p) => enabled.has(p.id) && typeof p.artistAlbumIds === 'function',
	);
	const provider =
		(preferred ? candidates.find((p) => p.id === preferred) : null) ?? candidates[0];
	if (!provider?.artistAlbumIds) {
		return json(
			{
				error: {
					code: 'NO_ARTIST_PROVIDER',
					message:
						'No enabled provider can expand an artist. Deezer supports artist fan-out; the Tidal instance exposes artist metadata but no track listing.',
				},
			},
			{ status: 409 },
		);
	}

	let albumIds: string[];
	try {
		albumIds = await provider.artistAlbumIds(artistId, maxAlbums);
	} catch (err) {
		log.warn('artist album listing failed', {
			provider: provider.id,
			artistId,
			error: String(err),
		});
		return json(
			{ error: { code: 'ARTIST_LOOKUP_FAILED', message: String(err).slice(0, 200) } },
			{ status: 502 },
		);
	}
	if (albumIds.length === 0) {
		return json(
			{
				error: {
					code: 'NO_ALBUMS',
					message: `${provider.displayName} returned no albums.`,
				},
			},
			{ status: 404 },
		);
	}

	// Album track lists need the gateway on Deezer; a single album failing must not
	// abandon the rest of the fan-out.
	const jobIds: string[] = [];
	const failedAlbums: string[] = [];
	let truncated = false;
	for (const albumId of albumIds) {
		if (jobIds.length >= maxTracks) {
			truncated = true;
			break;
		}
		let trackIds: string[] = [];
		try {
			trackIds = provider.albumTrackIds ? await provider.albumTrackIds(albumId) : [];
		} catch (err) {
			log.debug('artist fan-out: album listing failed', {
				provider: provider.id,
				albumId,
				error: String(err),
			});
			failedAlbums.push(albumId);
			continue;
		}
		for (const trackId of trackIds) {
			if (jobIds.length >= maxTracks) {
				truncated = true;
				break;
			}
			const job = await enqueueJob({
				type: 'download',
				payload: {
					url: trackPageUrl(provider.id, trackId) ?? trackId,
					provider: provider.id,
				},
				createdBy: locals.user.id,
			});
			jobIds.push(job.id);
		}
	}

	log.info('artist fan-out enqueued', {
		provider: provider.id,
		artistId,
		albums: albumIds.length,
		tracks: jobIds.length,
		failedAlbums: failedAlbums.length,
		truncated,
	});
	return json(
		{
			enqueued: jobIds.length,
			artistId,
			provider: provider.id,
			albumsScanned: albumIds.length,
			albumsFailed: failedAlbums.length,
			truncated,
			jobIds,
		},
		{ status: 202 },
	);
};

void getProvider;
