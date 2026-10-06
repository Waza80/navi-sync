import { logger } from '$lib/server/logger';
import { looksCanonical, pickStrict } from '../match';
import type { MetadataPatch, MetadataQuery, MetadataSource } from '../types';

/**
 * MusicBrainz + Cover Art Archive. No auth, no key, no account — the
 * canonical open music encyclopedia. Authoritative for album/release data and
 * the only free source that serves real cover art by ISRC.
 *
 * The hard part is that MusicBrainz holds MANY recordings with the same title
 * (covers, DJ mixes, live rips, compilations). Writing any of those onto a
 * real file would be worse than leaving the field empty, so a candidate must
 * satisfy BOTH:
 *   1. an Official release whose release-group primary type is a plain Album
 *      or Single (excludes bootlegs, compilations, live sets, DJ mixes), and
 *   2. a strict title+artist match (see ../match.ts).
 * When nothing qualifies the source returns null and the field stays empty.
 *
 * Docs: https://musicbrainz.org/doc/MusicBrainz_API
 */

const log = logger;
const MB = 'https://musicbrainz.org/ws/2';
// Same organisation, different host, and it 307-redirects to archive.org.
const CAA = 'https://coverartarchive.org';
const UA = 'navi-sync/1.0 ( https://github.com/Waza80/navi-sync )';
const TIMEOUT_MS = 15_000;
/** MusicBrainz asks for <=1 req/sec from anonymous clients. */
let lastCall = 0;

async function politeFetch(url: string): Promise<Response | null> {
	const wait = 1100 - (Date.now() - lastCall);
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	lastCall = Date.now();
	try {
		return await fetch(url, {
			headers: { 'User-Agent': UA, Accept: 'application/json' },
			signal: AbortSignal.timeout(TIMEOUT_MS),
			// Cover Art Archive 307-redirects to archive.org; without this the
			// release JSON comes back as a redirect stub and parses to nothing.
			redirect: 'follow',
		});
	} catch (err) {
		log.debug('musicbrainz request failed', { error: String(err) });
		return null;
	}
}

interface MbRelease {
	id?: string;
	title?: string;
	date?: string;
	status?: string;
	media?: Array<{ position?: number; format?: string }>;
	'release-group'?: { 'primary-type'?: string; 'secondary-types'?: string[] };
}

interface MbRecording {
	id?: string;
	title?: string;
	length?: number;
	isrcs?: string[];
	releases?: MbRelease[];
	'artist-credit'?: Array<{
		name?: string;
		artist?: { id?: string; name?: string; disambiguation?: string };
	}>;
}

/** Primary types that represent a real, canonical studio release. */
const CANONICAL_TYPES = new Set(['Album', 'Single']);

interface Chosen {
	recording: MbRecording;
	release: MbRelease;
	albumArtist: string | null;
	/**
	 * True when the release is Expunged and was accepted for its artwork ONLY.
	 * Every identity field is then withheld: the Cover Art Archive has the picture,
	 * but an expunged release must not decide this album's name, year or numbering.
	 */
	artworkOnly?: boolean;
}

function yearOf(date: string | undefined): number | null {
	const m = /^(\d{4})/.exec(date ?? '');
	if (!m?.[1]) return null;
	const y = Number.parseInt(m[1], 10);
	return Number.isFinite(y) ? y : null;
}

/**
 * A Cover Art Archive URL that has been CHECKED to exist, or null.
 *
 * The previous version constructed `/front-1200` from the release id and
 * returned it as fact. Measured: for release 3dec9a86… (Tanger, "La Memoire
 * Insoluble") CAA answers 404 for front, front-1200 and back — that release has
 * no artwork at all — yet the resolver reported the URL as corroborated
 * metadata. A guessed URL is worse than none, because the cover repair pass then
 * writes it into the DB and tags it into the file.
 *
 * CAA redirects to archive.org (307) so the redirect must be followed, and its
 * release JSON lists exactly which images exist and at which sizes. Verified on
 * Daft Punk "Discovery": images[0].types = ['Front'], thumbnails 1200/250/500/
 * large/small.
 *
 * Preference is Front, then Medium, then Back — a box set or a book-style
 * release can have a spine and no front, and refusing to use it leaves the album
 * bare for no reason.
 */
async function coverUrlFor(releaseId: string | undefined): Promise<string | null> {
	if (!releaseId) return null;
	const res = await politeFetch(`${CAA}/release/${releaseId}`);
	if (!res || !res.ok) return null;
	const body = (await res.json().catch(() => null)) as {
		images?: Array<{
			types?: string[];
			approved?: boolean;
			// The Cover Art Archive returns `thumbnails` as a map of size -> URL
			// STRING. It was typed as `{ url: string }` and read as
			// `thumbs[size]?.url`, so `.url` on a string is undefined, the loop
			// could never return, and this function answered null for EVERY
			// release — MusicBrainz had never once supplied a cover in this
			// library. Both shapes are accepted so the fallback is harmless.
			thumbnails?: Record<string, string | { url?: string }>;
		}>;
	} | null;
	const images = (body?.images ?? []).filter((i) => i.thumbnails);
	if (images.length === 0) return null;

	// Approved art only when it exists: an unapproved image is a placeholder.
	const pool = images.filter((i) => i.approved !== false);
	const usable = pool.length > 0 ? pool : images;
	const rank = (types: string[] | undefined): number => {
		const t = (types ?? []).map((x) => x.toLowerCase());
		if (t.includes('front')) return 0;
		if (t.includes('medium')) return 1;
		if (t.includes('back')) return 2;
		return 3;
	};
	usable.sort((a, b) => rank(a.types) - rank(b.types));
	for (const image of usable) {
		const thumbs = image.thumbnails ?? {};
		// Largest first: 1200 is the useful embed size, then the rest.
		for (const size of ['1200', 'large', '500', '250', 'small']) {
			const entry = thumbs[size];
			const url = typeof entry === 'string' ? entry : entry?.url;
			if (url) return url;
		}
	}
	return null;
}

function artistName(rec: MbRecording): string | null {
	return rec['artist-credit']?.[0]?.name ?? rec['artist-credit']?.[0]?.artist?.name ?? null;
}

/**
 * The artist's MusicBrainz id, which is the only stable identity we have.
 *
 * Two different artists can share a name — Deezer files a French rapper and a US
 * electronic producer both as "Tanger" on one artist page (110750), and
 * MusicBrainz separates them as 9ba3809e… ("French band") and 7d90e27a…
 * ("Electronic music producer"). Everything that groups tracks into artists must
 * key on this rather than on the display string.
 */
function artistMbid(rec: MbRecording): string | null {
	return rec['artist-credit']?.[0]?.artist?.id ?? null;
}

/**
 * A release is canonical when MusicBrainz marks it Official AND its release
 * group is a plain Album/Single with no secondary types (Live, Compilation,
 * DJ-mix, Remix, Soundtrack, Mixtape/Street …).
 */
function isCanonicalRelease(r: MbRelease): boolean {
	if (r.status && r.status !== 'Official') return false;
	const primary = r['release-group']?.['primary-type'];
	if (primary && !CANONICAL_TYPES.has(primary)) return false;
	const secondary = r['release-group']?.['secondary-types'] ?? [];
	if (secondary.length > 0) return false;
	// Title guard catches catalogs with incomplete release-group data.
	return looksCanonical(r.title);
}

function canonicalReleases(rec: MbRecording): MbRelease[] {
	return (rec.releases ?? []).filter(isCanonicalRelease);
}

/**
 * Releases allowed to supply ARTWORK only.
 *
 * Expunged is MusicBrainz's "this entity was removed" status, and the canonical
 * rule rightly excludes it — an expunged release must never decide an album's
 * identity, year or track numbers. But the artwork on such a release is still
 * real, often verified, and frequently the ONLY artwork anywhere: PRETTY
 * DOLLCORPSE is release 5cfb3294, Expunged, with approved front and back images
 * in the Cover Art Archive, and no Official alternative. Excluding it entirely
 * left the album permanently uncoverable.
 *
 * So: artwork is allowed to fall back to a release that identity will not touch.
 * `status: Expunged` is included deliberately; a `Pseudo-Release` or deleted
 * entry is not.
 */
function artworkReleases(rec: MbRecording): MbRelease[] {
	return (rec.releases ?? []).filter((r) => {
		if (isCanonicalRelease(r)) return true;
		return r.status === 'Expunged';
	});
}

/** Prefer the release that looks like the definitive studio edition. */
function releaseScore(r: MbRelease): number {
	let score = 0;
	const primary = r['release-group']?.['primary-type'];
	if (primary === 'Album') score += 3;
	if (primary === 'Single') score += 1;
	if (r.media?.length) score += 1;
	// A title with no edition noise outranks a reissue.
	if (looksCanonical(r.title)) score += 2;
	return score;
}

async function toPatch(chosen: Chosen, needed: MetadataQuery['needed']): Promise<MetadataPatch> {
	const { recording: rec, release } = chosen;
	if (chosen.artworkOnly) {
		// Cover and nothing else — see `artworkOnly`.
		return needed.includes('coverUrl') ? { coverUrl: await coverUrlFor(release.id) } : {};
	}
	return {
		...(needed.includes('album') && release.title ? { album: release.title } : {}),
		...(needed.includes('albumArtist') && chosen.albumArtist
			? { albumArtist: chosen.albumArtist }
			: {}),
		...(needed.includes('coverUrl') ? { coverUrl: await coverUrlFor(release.id) } : {}),
		...(needed.includes('year') ? { year: yearOf(release.date) } : {}),
		// Track and disc numbers are merged in by the caller, which must fetch the
		// release's track list: they are absent from the search payload, and
		// `media[].position` is the DISC number -- reading a track number from
		// there reports 1 for every track on the album.
		...(needed.includes('isrc') && rec.isrcs?.[0] ? { isrc: rec.isrcs[0] } : {}),
		...(needed.includes('artistMbid') && artistMbid(rec)
			? { artistMbid: artistMbid(rec) }
			: {}),
	};
}

/**
 * Strict selection. An ISRC hit is authoritative (it identifies the exact
 * recording); otherwise the recording must pass title+artist matching AND
 * expose at least one canonical release.
 */
function choose(recs: MbRecording[], query: MetadataQuery): Chosen | null {
	if (recs.length === 0) return null;
	const wanted = query.isrc?.toUpperCase();
	const byIsrc = wanted
		? recs.find((r) => r.isrcs?.some((i) => i.toUpperCase() === wanted))
		: undefined;
	const pool = byIsrc ? [byIsrc] : recs;

	const strict = byIsrc
		? pool
		: (() => {
				const hit = pickStrict(
					{
						title: query.title,
						artist: query.artist,
						durationSec: query.durationSec,
					},
					pool
						.filter((r) => r.title && canonicalReleases(r).length > 0)
						.map((r) => ({
							title: r.title ?? '',
							artist: artistName(r) ?? '',
							durationSec:
								typeof r.length === 'number' ? Math.round(r.length / 1000) : null,
						})),
				);
				return hit ? pool.filter((r) => r.title === hit.title) : [];
			})();

	for (const rec of strict) {
		const releases = canonicalReleases(rec);
		if (releases.length === 0) continue;
		const release = releases.reduce((best, r) =>
			releaseScore(r) > releaseScore(best) ? r : best,
		);
		return { recording: rec, release, albumArtist: artistName(rec) };
	}
	// No canonical release, so the strict path above returns nothing. Before
	// giving up, look for a recording matched by title+artist whose only release
	// is Expunged — enough to lend us its cover art, not its identity.
	if (!wanted) {
		const lenient = pickStrict(
			{ title: query.title, artist: query.artist, durationSec: query.durationSec },
			recs
				.filter((r) => r.title && artworkReleases(r).length > 0)
				.map((r) => ({
					title: r.title ?? '',
					artist: artistName(r) ?? '',
					durationSec: typeof r.length === 'number' ? Math.round(r.length / 1000) : null,
				})),
		);
		if (lenient) {
			const rec = recs.find((r) => r.title === lenient.title);
			if (rec) {
				const art = artworkReleases(rec).reduce((best, r) =>
					releaseScore(r) > releaseScore(best) ? r : best,
				);
				return {
					recording: rec,
					release: art,
					albumArtist: artistName(rec),
					artworkOnly: true,
				};
			}
		}
	}
	return null;
}

async function search(query: string): Promise<MbRecording[]> {
	const res = await politeFetch(
		`${MB}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=25&inc=releases+release-groups+artist-credits+isrcs`,
	);
	if (!res?.ok) return [];
	const body = (await res.json()) as { recordings?: MbRecording[] };
	return body.recordings ?? [];
}

/**
 * True track/disc numbers for a recording on a given release.
 *
 * The search endpoint returns releases WITHOUT their track lists, and on a
 * release object `media[].position` is the DISC number — not the track number.
 * Reading a track number from there yields 1 for every track on the album, which
 * silently scrambles album ordering. The real position lives in the medium's
 * track list, keyed by recording id, so it costs one extra (rate-limited)
 * request — paid only when a track number is actually wanted.
 */
async function fetchTrackNumbers(
	releaseId: string | undefined,
	recordingId: string | undefined,
	recordingTitle?: string,
): Promise<{ trackNumber: number | null; discNumber: number | null }> {
	if (!releaseId || !recordingId) return { trackNumber: null, discNumber: null };
	const res = await politeFetch(`${MB}/release/${releaseId}?inc=recordings&fmt=json`);
	if (!res?.ok) return { trackNumber: null, discNumber: null };
	const body = (await res.json()) as {
		media?: Array<{
			position?: number;
			tracks?: Array<{
				// `id` here is the TRACK MBID; the recording lives under `recording`.
				id?: string;
				position?: number;
				title?: string;
				recording?: { id?: string; title?: string };
			}>;
		}>;
	};
	const norm = (v: string | undefined): string =>
		String(v ?? '')
			.normalize('NFD')
			.replace(/\p{Diacritic}/gu, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '')
			.trim();
	const wantedTitle = norm(recordingTitle);
	for (const medium of body.media ?? []) {
		for (const track of medium.tracks ?? []) {
			const position = typeof track.position === 'number' ? track.position : null;
			if (position == null) continue;
			const disc = medium.position ?? null;
			// Prefer the recording id. `track.id` is the TRACK MBID, not the
			// recording's, so matching on it silently found nothing and every
			// album reported no track numbers at all.
			if (track.recording?.id && track.recording.id === recordingId) {
				return { trackNumber: position, discNumber: disc };
			}
		}
	}
	// Fallback by title: recordings get merged and redirected in MusicBrainz, so
	// the id can drift while the release track list still names the song.
	if (wantedTitle) {
		for (const medium of body.media ?? []) {
			for (const track of medium.tracks ?? []) {
				const position = typeof track.position === 'number' ? track.position : null;
				if (position == null) continue;
				const name = norm(track.recording?.title ?? track.title);
				if (name && name === wantedTitle) {
					return { trackNumber: position, discNumber: medium.position ?? null };
				}
			}
		}
	}
	return { trackNumber: null, discNumber: null };
}

export const musicbrainzSource: MetadataSource = {
	id: 'musicbrainz',
	displayName: 'MusicBrainz',
	requiresAuth: false,
	async lookup(query: MetadataQuery): Promise<MetadataPatch | null> {
		// ISRC first — authoritative, no fuzzy matching required.
		if (query.isrc) {
			const chosen = choose(await search(`isrc:${query.isrc}`), query);
			if (chosen) return withTrackNumbers(chosen, query);
		}
		const chosen = choose(
			await search(`recording:"${query.title}" AND artist:"${query.artist}"`),
			query,
		);
		if (!chosen) {
			log.debug('musicbrainz: no canonical release matched', {
				title: query.title,
				artist: query.artist,
			});
			return null;
		}
		return withTrackNumbers(chosen, query);
	},
};

/**
 * toPatch plus the release's real track/disc positions.
 *
 * The extra request is only made when a number is actually wanted, so the common
 * case (album/year/artist only) stays at one call.
 */
async function withTrackNumbers(
	chosen: Chosen,
	query: MetadataQuery,
): Promise<MetadataPatch | null> {
	const patch = await toPatch(chosen, query.needed);
	const wantsTrack = query.needed.includes('trackNumber');
	const wantsDisc = query.needed.includes('discNumber');
	if (!wantsTrack && !wantsDisc) return patch;
	const { trackNumber, discNumber } = await fetchTrackNumbers(
		chosen.release.id,
		chosen.recording.id,
		chosen.recording.title,
	);
	if (wantsTrack && trackNumber != null) patch.trackNumber = trackNumber;
	if (wantsDisc && discNumber != null) patch.discNumber = discNumber;
	return patch;
}
