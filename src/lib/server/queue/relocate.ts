import { logger } from '$lib/server/logger';
import { providers } from '$lib/server/providers/registry';
import type { Provider, TrackMeta, TrackRef } from '$lib/server/providers/types';

/**
 * Re-locate a track on whichever provider is actually available.
 *
 * A queued job carries BOTH a URL and a provider name, and the two can drift
 * apart badly enough to make the pair unusable:
 *
 *   - the URL points at a provider that has since been switched off (a Deezer
 *     link while Deezer is disabled), or
 *   - the URL points at a host that no longer exists at all — jobs queued before
 *     the Monochrome→Tidal migration still carry `tracks.monochrome.st` links,
 *     so naming Tidal as the provider and handing it a Monochrome URL made
 *     `parseRef` fail and burned all three attempts.
 *
 * Neither is a reason to give up, because the job also carries the title and
 * artist. So when URL routing fails we fall back to asking the ENABLED
 * providers to find the song by name. Tidal resolves ISRCs authoritatively and
 * otherwise takes the best strict title+artist match, which is what the user
 * means by "have Tidal match the song to download it from its place".
 */

const log = logger;

export interface RelocateQuery {
	title: string;
	artist: string;
	album?: string | null;
	isrc?: string | null;
	durationSec?: number | null;
}

export interface Relocated {
	provider: Provider;
	ref: TrackRef;
	meta: TrackMeta;
}

/** Case/punctuation/accent-insensitive comparison for match scoring. */
function normalize(value: string | null | undefined): string {
	return String(value ?? '')
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/** Exact (normalized) title equality. */
function titleMatches(want: string, got: string): boolean {
	const w = normalize(want);
	const g = normalize(got);
	return w.length > 0 && w === g;
}

/** Artist equality, allowing for a featured-artist suffix on either side. */
function artistMatches(want: string, got: string): boolean {
	const w = normalize(want);
	const g = normalize(got);
	if (!w || !g) return false;
	if (w === g) return true;
	return w.includes(g) || g.includes(w);
}

/**
 * How well a candidate matches the wanted song.
 *
 * Deliberately conservative and fully deterministic: an exact title is required
 * before anything is accepted, because filing the wrong recording is far worse
 * than reporting "not found" and leaving the row alone.
 */
function scoreCandidate(want: RelocateQuery, got: TrackMeta): number {
	const wt = normalize(want.title);
	const gt = normalize(got.title);
	if (!wt || !gt || wt !== gt) return 0;

	let score = 10;
	const wa = normalize(want.artist);
	const ga = normalize(got.artist);
	if (wa && ga) {
		if (wa === ga) score += 6;
		// "Artist feat. Someone" vs "Artist" is still the same recording.
		else if (wa.includes(ga) || ga.includes(wa)) score += 3;
		else return 0;
	}
	if (want.album && got.album && normalize(want.album) === normalize(got.album)) score += 2;
	if (want.isrc && got.isrc && want.isrc.toUpperCase() === got.isrc.toUpperCase()) score += 8;
	// Duration is a tie-breaker only — encoders and edits shift it either way.
	if (
		typeof want.durationSec === 'number' &&
		typeof got.durationSec === 'number' &&
		Math.abs(want.durationSec - got.durationSec) <= 3
	) {
		score += 2;
	}
	return score;
}

/**
 * Find `query` on the given providers (default: all of them, registry order).
 * Returns the highest-scoring strict match, or null when nothing qualifies.
 */
export async function relocateTrack(
	query: RelocateQuery,
	only?: ReadonlySet<string>,
): Promise<Relocated | null> {
	const title = query.title?.trim() ?? '';
	const artist = query.artist?.trim() ?? '';
	if (!title) return null;

	const candidates = only ? providers.filter((p) => only.has(p.id)) : providers;
	let best: { score: number; provider: Provider; meta: TrackMeta } | null = null;

	// ── 1. ISRC first — authoritative, and immune to search's fuzzy failures ──
	// Catalog text search is unreliable for exactly the tracks that need help:
	// Tidal answers "reggie petrucci DISPARAÎTRE" with a Michel Petrucciani
	// piano recording because the surname token matches. An exact ISRC cannot
	// make that mistake.
	if (query.isrc?.trim()) {
		for (const provider of candidates) {
			// Prefer the album-aware variant: Tidal reuses ISRCs across
			// compilations, and without the album hint an ambiguous ISRC would
			// file the track under the wrong release.
			if (!provider.findByIsrc && !provider.findByIsrcInAlbum) continue;
			const meta = await (
				provider.findByIsrcInAlbum
					? provider.findByIsrcInAlbum(
							query.isrc.trim(),
							query.artist,
							query.title,
							query.album ?? null,
						)
					: provider.findByIsrc!(query.isrc.trim())
			)
				.then((m) => m ?? null)
				.catch((err) => {
					log.debug('relocate isrc lookup failed', {
						provider: provider.id,
						error: String(err),
					});
					return null;
				});
			if (!meta) continue;
			// Guard against a provider answering with a different recording.
			if (meta.isrc && meta.isrc.toUpperCase() !== query.isrc.trim().toUpperCase()) continue;
			log.info('relocated track by ISRC', {
				title: query.title,
				artist: query.artist,
				provider: provider.id,
				isrc: query.isrc,
			});
			return {
				provider,
				ref: {
					provider: provider.id,
					id: meta.providerTrackId,
					...(meta.sourceUrl ? { sourceUrl: meta.sourceUrl } : {}),
				},
				meta,
			};
		}
	}

	// ── 2. Otherwise search by name, strictly ────────────────────────────────
	//
	// Tidal does NOT handle a combined "artist title" query reliably, and the
	// failure is silent: it returns a full page of plausible-looking unrelated
	// tracks instead of erroring. Measured against the instance:
	//
	//   "Neverlose"              -> 297 hits, all NEVERLOSE          OK
	//   "help_urself"            ->  75 hits, the right song        OK
	//   "Neverlose help_urself"  ->  98 hits, none by Neverlose     BROKEN
	//   "Moskau Denez Prigent"   -> 153 hits, right artist, wrong song (partial)
	//
	// So each shape is searched separately and the strictest survivor wins. A
	// title-only search must still match the artist and an artist-only search must
	// still match the title, so relaxing the QUERY never relaxes the MATCH.
	const shapes: Array<{ q: string; require?: 'artist' | 'title' }> = [
		{ q: `${artist} ${title}`.trim() },
		{ q: title.trim(), require: 'artist' },
		{ q: artist.trim(), require: 'title' },
	];
	for (const provider of candidates) {
		const seen = new Set<string>();
		for (const shape of shapes) {
			if (!shape.q) continue;
			let results: TrackMeta[];
			try {
				results = await provider.search(shape.q);
			} catch (err) {
				log.debug('relocate search failed', { provider: provider.id, error: String(err) });
				continue;
			}
			for (const meta of results) {
				if (seen.has(meta.providerTrackId)) continue;
				seen.add(meta.providerTrackId);
				// The other half of the identity still has to hold.
				if (shape.require === 'artist' && !artistMatches(artist, meta.artist)) continue;
				if (shape.require === 'title' && !titleMatches(title, meta.title)) continue;
				// An ISRC that contradicts the wanted one means a different recording.
				if (
					query.isrc &&
					meta.isrc &&
					meta.isrc.toUpperCase() !== query.isrc.toUpperCase()
				) {
					continue;
				}
				const score = scoreCandidate(query, meta);
				if (score > 0 && (!best || score > best.score)) {
					best = { score, provider, meta };
				}
			}
		}
	}

	if (!best) {
		log.info('relocate found no strict match', {
			title,
			artist,
			providers: candidates.map((p) => p.id).join(','),
		});
		return null;
	}

	const ref: TrackRef = {
		provider: best.provider.id,
		id: best.meta.providerTrackId,
		...(best.meta.sourceUrl ? { sourceUrl: best.meta.sourceUrl } : {}),
	};
	if (!ref.id) return null;
	log.info('relocated track by name', {
		title,
		artist,
		provider: best.provider.id,
		score: best.score,
	});
	return { provider: best.provider, ref, meta: best.meta };
}
