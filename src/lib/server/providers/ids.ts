/**
 * Provider track-id hygiene.
 *
 * Failed-track rows historically stored full page URLs (sometimes even
 * doubled URLs) in `provider_track_id`, which broke retries and duplicated
 * rows. These helpers canonicalize on write and build page URLs defensively
 * on read — every call site must go through them.
 */

/** Canonical native id for a provider (deezer: trailing numeric id). */
export function canonicalTrackId(
	provider: string,
	value: string | null | undefined,
): string | null {
	const v = (value ?? '').trim();
	if (!v) return null;
	if (provider === 'deezer') {
		// Take the LAST numeric run — heals already-doubled URLs too.
		const runs = v.match(/\d{4,15}/g);
		return runs && runs.length > 0 ? runs[runs.length - 1] : v;
	}
	return v;
}

/** Public track page URL for a provider id. Never double-prefixes. */
export function trackPageUrl(provider: string, trackId: string | null | undefined): string | null {
	const id = canonicalTrackId(provider, trackId);
	if (!id) return null;
	if (/^https?:\/\//i.test(id)) return id;
	if (provider === 'tidal') return `https://tidal.com/track/${id}`;
	if (provider === 'deezer') return `https://www.deezer.com/track/${id}`;
	return id;
}
