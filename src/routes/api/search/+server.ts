import { z } from 'zod';
import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { enabledProviders } from '$lib/server/providers/enabled';
import type { TrackMeta } from '$lib/server/providers/types';
import type { RequestHandler } from './$types';

const searchSchema = z.object({ q: z.string().min(2).max(200) });

/**
 * GET /api/search?q= — fans out to every provider with search capability and
 * merges results (provider-tagged) for the dashboard search UI.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) return unauthorizedResponse();
	const parsed = searchSchema.safeParse({ q: url.searchParams.get('q') ?? '' });
	if (!parsed.success) return badRequest('Query must be 2-200 characters.', 'INVALID_QUERY');

	// A pasted LINK is a request to act on that thing, not to search for its
	// words. Deezer artist/album/track URLs (and their link.deezer.com short
	// forms) are classified here so the UI can fan out instead of sending the URL
	// to every provider's text search, which returns nothing useful for one.
	const linked = await resolvePastedLink(parsed.data.q);

	const providers = await enabledProviders();
	const [trackLists, albumLists, artistLists] = await Promise.all([
		Promise.all(
			providers.map(async (p) => {
				try {
					const metas: TrackMeta[] = await p.search(parsed.data.q);
					return metas.map((m) => ({
						provider: p.id,
						providerTrackId: m.providerTrackId,
						title: m.title,
						artist: m.artist,
						album: m.album,
						durationSec: m.durationSec,
						sourceUrl: m.sourceUrl,
					}));
				} catch {
					return [];
				}
			}),
		),
		Promise.all(
			providers.map(async (p) => {
				if (!p.searchAlbums) return [];
				try {
					return await p.searchAlbums(parsed.data.q);
				} catch {
					return [];
				}
			}),
		),
		// Artists, for fan-out ("download everything by X"). Only providers that
		// can actually expand an artist are asked, so the UI never offers a button
		// that cannot work.
		Promise.all(
			providers.map(async (p) => {
				if (!p.searchArtists || !p.artistAlbumIds) return [];
				try {
					return (await p.searchArtists(parsed.data.q)).map((a) => ({
						provider: p.id,
						artistId: a.artistId,
						name: a.name,
						albumCount: a.trackCount,
					}));
				} catch {
					return [];
				}
			}),
		),
	]);
	return json({
		results: trackLists.flat(),
		albums: albumLists.flat(),
		artists: artistLists.flat(),
		// Present when the query was a provider link; the UI offers fan-out for it.
		link: linked,
	});
};

/**
 * Classify a pasted provider URL. Short links are resolved through the owning
 * provider's parseRef (which follows the redirect), so `link.deezer.com/s/…`
 * reports the kind of whatever it actually points at.
 */
async function resolvePastedLink(q: string): Promise<{
	provider: string;
	kind: 'track' | 'album' | 'artist' | 'playlist';
	id: string;
	sourceUrl: string | null;
} | null> {
	const trimmed = q.trim();
	if (!/^https?:\/\//i.test(trimmed)) return null;
	const { providers } = await import('$lib/server/providers/registry');
	for (const p of providers) {
		try {
			const ref = await p.parseRef(trimmed);
			if (!ref) continue;
			const url = ref.sourceUrl ?? trimmed;
			// parseRef normalises sourceUrl, so the kind can be read back off it.
			const kind = /\/artist\//.test(url)
				? 'artist'
				: /\/album\//.test(url)
					? 'album'
					: /\/playlist\//.test(url)
						? 'playlist'
						: 'track';
			return { provider: ref.provider, kind, id: ref.id, sourceUrl: ref.sourceUrl ?? null };
		} catch {
			continue;
		}
	}
	return null;
}
