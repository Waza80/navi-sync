import { env } from '$lib/server/env';
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
/**
 * BrainzMash is a MusicBrainz `/ws/2` mirror that answers at 4 req/sec instead
 * of the official 1 req/sec — a whole-library reindex is bounded by that rate,
 * so the mirror is the primary host. It is not a fork and speaks the same
 * dialect: the same paths, parameters and JSON shapes.
 *
 * It is also gated case-by-case by its operator, and this deployment is not on
 * the allow-list yet: `https://api.brainzmash.cc/ws/2/...` answers 403 from both
 * the dev host and the production host. So every request has a fallback to the
 * official MusicBrainz host, and a failure parks the mirror for a SHORT,
 * status-shaped cooldown — seconds, never minutes, see `cooldownMsForStatus` —
 * instead of paying the round-trip on every call. Metadata therefore keeps
 * working before access is granted, and starts using the faster host
 * automatically once it is.
 *
 * Set `MUSICBRAINZ_BASE_URL` to override the primary (an empty value means "use
 * the official host only").
 */
const MB_OFFICIAL = 'https://musicbrainz.org/ws/2';
const MB_BRAINZMASH = 'https://api.brainzmash.cc/ws/2';
const configuredBase = env.MUSICBRAINZ_BASE_URL?.replace(/\/+$/, '');
const MB_PRIMARY = configuredBase ?? MB_BRAINZMASH;
const MB_HAS_FALLBACK = MB_PRIMARY !== MB_OFFICIAL;
/** The official host asks for <=1 req/sec; BrainzMash allows 4 req/sec. */
const INTERVAL_OFFICIAL_MS = 1100;
const INTERVAL_PRIMARY_MS = MB_PRIMARY === MB_OFFICIAL ? INTERVAL_OFFICIAL_MS : 250;
/**
 * Cooldown after a mirror failure, by status. The operator policy is SECONDS,
 * never minutes: the previous 10-minute park meant one 429 during a reindex
 * silently pinned every following request to the 1 req/sec official host for
 * the rest of the sweep.
 *
 *   429      -> 2s   rate limited; retry almost immediately
 *   401/403  -> 10s  gated access; the longest cooldown allowed
 *   5xx/net  -> 5s   host unwell; brief pause before re-asking it
 */
export function cooldownMsForStatus(status: number | null): number {
	if (status === 429) return 2_000;
	if (status === 401 || status === 403) return 10_000;
	return 5_000;
}

// Same organisation, different host, and it 307-redirects to archive.org.
const CAA = 'https://coverartarchive.org';
const UA = 'Lidarr/2.0.0.5284';
const TIMEOUT_MS = 15_000;

/**
 * Serialized, per-origin rate limiting.
 *
 * The previous limiter was `lastCall` + a wait, which two concurrent jobs could
 * both pass (check, then set) — so a reindex that ran sources in parallel could
 * exceed the official 1 req/sec and get the IP throttled. Chaining every request
 * through one promise makes the interval a real guarantee; the interval used is
 * the strictest one currently in play, because the chain is shared.
 */
let chain: Promise<unknown> = Promise.resolve();
const lastCall = new Map<string, number>();
let mirrorBlockedUntil = 0;

function throttle(origin: string, intervalMs: number): Promise<void> {
	const run = chain.then(async () => {
		const last = lastCall.get(origin) ?? 0;
		const wait = intervalMs - (Date.now() - last);
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		lastCall.set(origin, Date.now());
	});
	chain = run.catch(() => undefined);
	return run;
}

async function rawFetch(url: string, intervalMs: number): Promise<Response | null> {
	await throttle(new URL(url).origin, intervalMs);
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

/**
 * One pause-and-retry inside the SAME request, for burst-shaped failures only.
 *
 * MusicBrainz answers `503 busy` to bursts even at the documented polite rate,
 * and during a full-library reindex a single-shot 503 silently dropped most of a
 * job's chain while the job itself still "succeeded" (measured: a forced pass
 * over 170 rows filled MusicBrainz ids for only 6). The delay is the same
 * status-shaped cooldown the mirror parking uses (429 → 2s, 5xx → 5s); if the
 * second attempt fails too, the caller sees the failure exactly as before.
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

async function fetchWithBurstRetry(url: string, intervalMs: number): Promise<Response | null> {
	let res = await rawFetch(url, intervalMs);
	if (res === null || (res && !res.ok && RETRYABLE_STATUSES.has(res.status))) {
		await new Promise((resolve) =>
			setTimeout(resolve, res === null ? 2_000 : cooldownMsForStatus(res.status)),
		);
		res = await rawFetch(url, intervalMs);
	}
	return res;
}

/**
 * One `/ws/2` request, mirror first with a transparent fallback.
 *
 * `pathAndQuery` starts with `/` and is identical on both hosts. A 404 is a
 * real answer and is returned as-is; 401/403/429/5xx/network failure means "this
 * host cannot answer", so the official host is asked instead.
 */
async function mbFetch(pathAndQuery: string): Promise<Response | null> {
	if (Date.now() >= mirrorBlockedUntil) {
		const primary = await fetchWithBurstRetry(
			`${MB_PRIMARY}${pathAndQuery}`,
			INTERVAL_PRIMARY_MS,
		);
		if (primary?.ok) return primary;
		if (primary && primary.status === 404) {
			// A 404 from the mirror is the same 404 the official host would give.
			return primary;
		}
		// Any other failure parks the PRIMARY for a short, status-shaped cooldown
		// (see cooldownMsForStatus). Only parked when a separate official host
		// exists to serve the fallback: parking the official host itself would
		// turn one 429 into dropped lookups while the throttle already spaces it.
		if (MB_HAS_FALLBACK) {
			const status = primary?.status ?? null;
			const cooldownMs = cooldownMsForStatus(status);
			mirrorBlockedUntil = Date.now() + cooldownMs;
			const cooldownSeconds = cooldownMs / 1000;
			if (status === 401 || status === 403) {
				log.warn('brainzmash refused the request; using official MusicBrainz', {
					status,
					cooldownSeconds,
				});
			} else {
				log.debug('brainzmash unavailable; using official MusicBrainz', {
					status,
					cooldownSeconds,
				});
			}
		}
	}
	if (!MB_HAS_FALLBACK) return null;
	return fetchWithBurstRetry(`${MB_OFFICIAL}${pathAndQuery}`, INTERVAL_OFFICIAL_MS);
}

/** Cover Art Archive fetch, on the official polite cadence. */
function politeFetch(url: string): Promise<Response | null> {
	return rawFetch(url, INTERVAL_OFFICIAL_MS);
}

interface MbArtistCredit {
	name?: string;
	artist?: { id?: string; name?: string; disambiguation?: string };
}

interface MbRelease {
	id?: string;
	title?: string;
	date?: string;
	status?: string;
	media?: Array<{ position?: number; format?: string }>;
	'release-group'?: { id?: string; 'primary-type'?: string; 'secondary-types'?: string[] };
	'artist-credit'?: MbArtistCredit[];
}

interface MbRecording {
	id?: string;
	title?: string;
	length?: number;
	isrcs?: string[];
	releases?: MbRelease[];
	'artist-credit'?: MbArtistCredit[];
}

/** Primary types that represent a real, canonical studio release. */
const CANONICAL_TYPES = new Set(['Album', 'Single']);

interface Chosen {
	recording: MbRecording;
	release: MbRelease;
	albumArtist: string | null;
	/**
	 * True when identity is proven — an ISRC hit, a stored MBID, or a strict
	 * title+artist(+duration) match — but the chosen release is NOT one
	 * MusicBrainz considers real (Bootleg, Promotion, Pseudo-Release,
	 * Expunged). The recording's artist identity and the release/release-group
	 * IDs are then safe to store, while descriptive facts (album name, year,
	 * track numbers) are withheld: an unofficial release must not rename the
	 * album.
	 */
	descriptiveWithheld?: boolean;
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

/**
 * May this release supply DESCRIPTIVE facts — album name, year, track numbers?
 * Only one MusicBrainz considers real: Official status (or no status at all on
 * a canonical group), never Bootleg/Promotion/Pseudo-Release/Expunged.
 */
function descriptiveSafe(r: MbRelease | null | undefined): boolean {
	if (!r || (!r.status && !r.title)) return false;
	if (r.status && r.status !== 'Official') return false;
	return r.status === 'Official' || isCanonicalRelease(r);
}

/**
 * The single best release for a recording: canonical studio edition first,
 * any Official release next, an Expunged one after that (artwork and identity
 * only — the caller gates descriptive fields), anything at all last. Null
 * only when the recording lists no releases whatsoever.
 */
function pickRelease(releases: MbRelease[]): MbRelease | null {
	if (releases.length === 0) return null;
	const best = (list: MbRelease[]): MbRelease | null =>
		list.length ? list.reduce((a, b) => (releaseScore(b) > releaseScore(a) ? b : a)) : null;
	return (
		best(releases.filter(isCanonicalRelease)) ??
		best(releases.filter((r) => r.status === 'Official')) ??
		best(releases.filter((r) => r.status === 'Expunged')) ??
		best(releases)
	);
}

/**
 * Build the Chosen for a recording whose IDENTITY is already proven (ISRC,
 * stored MBID, or a strict title+artist match). `preferred` is the release the
 * row already points at or the album the query matched — used verbatim when it
 * is safe, so a proven row keeps the album it already has. Descriptive fields
 * flow only from a `descriptiveSafe` release; a recording with no releases at
 * all still yields its identity (release left empty, everything gated).
 */
function chosenForProven(
	rec: MbRecording | undefined,
	preferred?: MbRelease | null,
): Chosen | null {
	if (!rec) return null;
	const release =
		preferred && descriptiveSafe(preferred)
			? preferred
			: (pickRelease(rec.releases ?? []) ?? {});
	return {
		recording: rec,
		release,
		albumArtist: albumArtistName(release, rec),
		descriptiveWithheld: !descriptiveSafe(release),
	};
}

/** The recording's release titled like this album — the match the query proved. */
function albumRelease(rec: MbRecording, album: string): MbRelease | null {
	const wanted = album.toLowerCase();
	return (rec.releases ?? []).find((r) => (r.title ?? '').toLowerCase() === wanted) ?? null;
}

async function toPatch(chosen: Chosen, needed: MetadataQuery['needed']): Promise<MetadataPatch> {
	const { recording: rec, release } = chosen;
	if (chosen.descriptiveWithheld) {
		// Identity proven, release unofficial: artwork and artist identity are
		// safe (the recording's artist-credit is canonical MusicBrainz data),
		// but descriptive facts (album name, year, track numbers, ISRC) are
		// withheld — an unofficial release must not rename the album.
		return {
			...(needed.includes('coverUrl') ? { coverUrl: await coverUrlFor(release.id) } : {}),
			...(needed.includes('artist') && artistName(rec) ? { artist: artistName(rec) } : {}),
			...(needed.includes('artistMbid') && artistMbid(rec)
				? { artistMbid: artistMbid(rec) }
				: {}),
			...(needed.includes('recordingMbid') && rec.id ? { recordingMbid: rec.id } : {}),
			...(needed.includes('releaseMbid') && release.id ? { releaseMbid: release.id } : {}),
			...(needed.includes('releaseGroupMbid') && release['release-group']?.id
				? { releaseGroupMbid: release['release-group'].id }
				: {}),
			...(needed.includes('albumArtistMbid') && albumArtistMbid(release, rec)
				? { albumArtistMbid: albumArtistMbid(release, rec) }
				: {}),
		};
	}
	return {
		...(needed.includes('album') && release.title ? { album: release.title } : {}),
		...(needed.includes('albumArtist') && chosen.albumArtist
			? { albumArtist: chosen.albumArtist }
			: {}),
		...(needed.includes('artist') && artistName(rec) ? { artist: artistName(rec) } : {}),
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
		// Identities. These are the fields that cannot be recovered from a
		// title+artist search later, so they are stored on the first resolution.
		...(needed.includes('recordingMbid') && rec.id ? { recordingMbid: rec.id } : {}),
		...(needed.includes('releaseMbid') && release.id ? { releaseMbid: release.id } : {}),
		...(needed.includes('releaseGroupMbid') && release['release-group']?.id
			? { releaseGroupMbid: release['release-group'].id }
			: {}),
		...(needed.includes('albumArtistMbid') && albumArtistMbid(release, rec)
			? { albumArtistMbid: albumArtistMbid(release, rec) }
			: {}),
	};
}

/** Release-level artist credit wins over the recording's: it is the album identity. */
function albumArtistMbid(release: MbRelease, rec: MbRecording): string | null {
	return release['artist-credit']?.[0]?.artist?.id ?? artistMbid(rec);
}

/**
 * The NAME half of the same rule: album_artist comes from the release's
 * credit, never the recording's. Feat credits vary track to track
 * ('Tanger, Frizk'), and Navidrome's album key includes album_artist — a
 * varying value splits one album into several entries.
 */
function albumArtistName(release: MbRelease, rec: MbRecording): string | null {
	return (
		release['artist-credit']?.[0]?.name ??
		release['artist-credit']?.[0]?.artist?.name ??
		artistName(rec)
	);
}

/**
 * The release this row already stores: locks one edition per album so forced
 * re-asks stop re-picking a different same-titled release on every run.
 */
function storedRelease(rec: MbRecording, query: MetadataQuery): MbRelease | undefined {
	return query.releaseMbid
		? (rec.releases ?? []).find((r) => r.id === query.releaseMbid)
		: undefined;
}

/**
 * Selection, strongest evidence first:
 *
 *   1. ISRC hit — identifies the exact recording, authoritative.
 *   2. Strict title+artist+duration match (pickStrict never guesses).
 *   3. Title+album, for rows whose artist string is corrupted.
 *   4. Unambiguous exact title — identity and artwork only.
 *
 * Steps 1–3 have PROVEN identity, so any release may lend the recording's
 * artist credit and MBIDs; descriptive facts (album, year, track numbers)
 * flow only from a `descriptiveSafe` release — see `chosenForProven`.
 */
function choose(recs: MbRecording[], query: MetadataQuery): Chosen | null {
	if (recs.length === 0) return null;
	const wanted = query.isrc?.toUpperCase();
	const byIsrc = wanted
		? recs.find((r) => r.isrcs?.some((i) => i.toUpperCase() === wanted))
		: undefined;
	// 1. An ISRC hit identifies the exact recording: identity proven.
	if (byIsrc) return chosenForProven(byIsrc, storedRelease(byIsrc, query));

	// 2. Strict title+artist+duration match (pickStrict never guesses): the
	// match itself proves identity, so the candidate set is every recording
	// with a title and at least one release — NOT only canonical ones. A
	// Bootleg/Promo-only recording can now lend its artist and MBIDs, while
	// `chosenForProven` keeps album/year gated on release safety.
	const hit = pickStrict(
		{
			title: query.title,
			artist: query.artist,
			durationSec: query.durationSec,
		},
		recs
			.filter((r) => r.title && (r.releases?.length ?? 0) > 0)
			.map((r) => ({
				title: r.title ?? '',
				artist: artistName(r) ?? '',
				durationSec: typeof r.length === 'number' ? Math.round(r.length / 1000) : null,
			})),
	);
	if (hit) {
		const matches = recs.filter((r) => r.title === hit.title && (r.releases?.length ?? 0) > 0);
		const match = matches.find((r) => (artistName(r) ?? '') === hit.artist) ?? matches[0];
		const chosen = chosenForProven(match, storedRelease(match, query));
		if (chosen) return chosen;
	}

	// Title + album fallback: when the artist string is corrupted (merged credits,
	// reordered names, etc.) strict title+artist matching never hits. Match by
	// recording title AND release (album) title instead — MusicBrainz already
	// knows the release, so this is unambiguous for one-track-per-release cases.
	// Check ALL releases (including Expunged) for the album title match, since
	// the only release for some recordings may be Expunged.
	if (!wanted && query.album) {
		const byTitleAlbum = recs.filter((r) => {
			const releases = r.releases ?? [];
			return (
				releases.some(
					(rel) => rel.title && rel.title.toLowerCase() === query.album!.toLowerCase(),
				) &&
				r.title &&
				r.title.toLowerCase() === query.title.toLowerCase()
			);
		});
		if (byTitleAlbum.length === 1) {
			// Identity proven by title+album: keep the album the query matched
			// when that release is safe, gate descriptive fields otherwise.
			const chosen = chosenForProven(
				byTitleAlbum[0],
				storedRelease(byTitleAlbum[0], query) ?? albumRelease(byTitleAlbum[0], query.album),
			);
			if (chosen) return chosen;
		}
		if (byTitleAlbum.length > 1) {
			// Multiple recordings with same title+album: disambiguate by duration.
			const withDuration = byTitleAlbum.filter((r) =>
				typeof r.length === 'number' && query.durationSec
					? Math.abs(r.length / 1000 - query.durationSec) <= 1.5
					: true,
			);
			if (withDuration.length === 1) {
				const chosen = chosenForProven(
					withDuration[0],
					storedRelease(withDuration[0], query) ??
						albumRelease(withDuration[0], query.album),
				);
				if (chosen) return chosen;
			}
		}
	}
	// The strict path above requires the artist to match, and it often cannot:
	// our album artist for a collaboration is the merged credit list ('Ptite
	// Soeur, neophron, FEMTOGO, reivilose, prxpvne, rosaliedu38') while the
	// recording credits three of those names, so `pickStrict` on artist never
	// matches and PRETTY DOLLCORPSE stayed uncoverable — and with cover_path
	// NULL there were no bytes to embed either.
	if (!wanted) {
		const withArt = recs.filter((r) => r.title && artworkReleases(r).length > 0);
		const exactTitle = withArt.filter((r) => r.title === query.title);

		// Exact title alone, and ONLY when unambiguous. Two recordings sharing
		// an exact title would make the cover a coin flip, so a unique match is
		// the condition, not a preference.
		if (exactTitle.length === 1) {
			const rec = exactTitle[0];
			const release = pickRelease(artworkReleases(rec)) ?? pickRelease(rec.releases ?? []);
			// Identity from a title-only guess is this source's standing contract:
			// the recording's artist-credit is canonical MusicBrainz data, and an
			// Expunged release still lends its stable ids. Descriptive facts NEVER
			// flow from an unproven artist — a title alone must not name the album.
			return {
				recording: rec,
				release: release ?? {},
				albumArtist: albumArtistName(release ?? {}, rec),
				descriptiveWithheld: true,
			};
		}
		return null;
	}
	return null;
}

/**
 * Candidate-widening tokens for a title the exact phrase could not find.
 *
 * Stored titles drift from MusicBrainz's copy ("Il ya un Ange" vs "Il y a
 * un ange"), and a quoted Lucene phrase matches NEITHER the typo nor the
 * correction — so a recording that exists came back as "no source". This
 * returns only the longest words of the stored title, ANDed as field terms.
 * `search` may now return a wider set, but `choose` still requires norm()-exact
 * title equality plus artist/duration where it demands them: the candidate set
 * widens, the acceptance bar does not.
 */
function fuzzyTitleQuery(title: string): string | null {
	const tokens = [
		...new Set(
			String(title ?? '')
				.split(/\s+/)
				.map((w) => norm(w))
				.filter((w) => w.length >= 3),
		),
	]
		.sort((a, b) => b.length - a.length)
		.slice(0, 3);
	return tokens.length > 0 ? tokens.map((t) => `recording:${t}`).join(' AND ') : null;
}

async function search(query: string): Promise<MbRecording[]> {
	const res = await mbFetch(
		`/recording?query=${encodeURIComponent(query)}&fmt=json&limit=25&inc=releases+release-groups+artist-credits+isrcs`,
	);
	if (!res?.ok) return [];
	const body = (await res.json()) as { recordings?: MbRecording[] };
	return body.recordings ?? [];
}

/** Loose text equality for MusicBrainz strings: case, punctuation and accents aside. */
function norm(v: string | undefined): string {
	return String(v ?? '')
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '')
		.trim();
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
): Promise<{
	trackNumber: number | null;
	discNumber: number | null;
	releaseTrackMbid: string | null;
}> {
	if (!releaseId || !recordingId)
		return { trackNumber: null, discNumber: null, releaseTrackMbid: null };
	const res = await mbFetch(`/release/${releaseId}?inc=recordings&fmt=json`);
	if (!res?.ok) return { trackNumber: null, discNumber: null, releaseTrackMbid: null };
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
				return {
					trackNumber: position,
					discNumber: disc,
					releaseTrackMbid: track.id ?? null,
				};
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
					return {
						trackNumber: position,
						discNumber: medium.position ?? null,
						releaseTrackMbid: track.id ?? null,
					};
				}
			}
		}
	}
	return { trackNumber: null, discNumber: null, releaseTrackMbid: null };
}

interface MbReleaseWithTracks extends MbRelease {
	media?: Array<{
		position?: number;
		format?: string;
		tracks?: Array<{
			id?: string;
			position?: number;
			title?: string;
			recording?: { id?: string; title?: string };
		}>;
	}>;
}

/** A recording fetched directly by MBID — one request, no search. */
async function fetchRecordingByMbid(mbid: string): Promise<MbRecording | null> {
	const res = await mbFetch(
		`/recording/${encodeURIComponent(mbid)}?inc=releases+release-groups+artist-credits+isrcs&fmt=json`,
	);
	if (!res?.ok) return null;
	const body = (await res.json().catch(() => null)) as MbRecording | null;
	return body?.id ? body : null;
}

/** A release WITH its track list — the search payload never carries tracks. */
async function fetchReleaseByMbid(mbid: string): Promise<MbReleaseWithTracks | null> {
	const res = await mbFetch(
		`/release/${encodeURIComponent(mbid)}?inc=artist-credits+release-groups+recordings&fmt=json`,
	);
	if (!res?.ok) return null;
	const body = (await res.json().catch(() => null)) as MbReleaseWithTracks | null;
	return body?.id ? body : null;
}

/** The track on a release whose (recording) title is `title`, compared loosely. */
function trackOf(
	release: MbReleaseWithTracks,
	title: string,
): {
	recordingId: string;
	recordingTitle: string;
	position: number | null;
	disc: number | null;
	trackId: string | null;
} | null {
	const wanted = norm(title);
	if (!wanted) return null;
	for (const medium of release.media ?? []) {
		for (const track of medium.tracks ?? []) {
			if (!track.recording?.id) continue;
			const name = norm(track.recording.title ?? track.title);
			if (name && name === wanted) {
				return {
					recordingId: track.recording.id,
					recordingTitle: track.recording.title ?? track.title ?? title,
					position: typeof track.position === 'number' ? track.position : null,
					disc: medium.position ?? null,
					trackId: track.id ?? null,
				};
			}
		}
	}
	return null;
}

/**
 * In-memory lookup cache.
 *
 * A forced repair re-asks several fields for the same row, and a retry re-runs
 * the whole chain for an identical query — the answer must not be paid for
 * twice within a short window. The cache also lets tests prime a known answer
 * instead of waiting on the live transport (see primeMusicBrainzLookup).
 */
const LOOKUP_TTL_MS = 15 * 60_000;
const LOOKUP_CACHE_MAX = 500;
const lookupCache = new Map<string, { at: number; patch: MetadataPatch | null }>();
const primedPatches: Array<MetadataPatch | null> = [];

function lookupCacheKey(query: MetadataQuery): string {
	return JSON.stringify([
		query.title,
		query.artist,
		query.album ?? null,
		query.isrc ?? null,
		query.durationSec ?? null,
		query.year ?? null,
		query.recordingMbid ?? null,
		query.releaseMbid ?? null,
		query.artistMbid ?? null,
		query.needed,
	]);
}

function clonePatch(patch: MetadataPatch | null): MetadataPatch | null {
	return patch === null ? null : { ...patch };
}

/**
 * Make the next lookup answer from memory instead of the network.
 *
 * Replaces any previous prime so tests cannot leak into each other; the queue
 * holds at most one entry and is consumed by the next lookup call.
 */
export function primeMusicBrainzLookup(patch: MetadataPatch | null): void {
	primedPatches.length = 0;
	primedPatches.push(patch);
}

/** Drop every cached answer (tests; after re-indexing related rows). */
export function clearMusicBrainzLookupCache(): void {
	lookupCache.clear();
	primedPatches.length = 0;
}

export const musicbrainzSource: MetadataSource = {
	id: 'musicbrainz',
	displayName: 'MusicBrainz',
	requiresAuth: false,
	async lookup(query: MetadataQuery): Promise<MetadataPatch | null> {
		const primed = primedPatches.shift();
		if (primed !== undefined) return clonePatch(primed);
		const key = lookupCacheKey(query);
		const hit = lookupCache.get(key);
		if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return clonePatch(hit.patch);
		const patch = await resolveLookup(query);
		lookupCache.set(key, { at: Date.now(), patch });
		if (lookupCache.size > LOOKUP_CACHE_MAX) {
			const oldest = lookupCache.keys().next().value;
			if (oldest !== undefined) lookupCache.delete(oldest);
		}
		return patch;
	},
};

/** The network-backed resolution the wrapper above caches. */
async function resolveLookup(query: MetadataQuery): Promise<MetadataPatch | null> {
	// A stored MBID beats every search: the row already knows which
	// MusicBrainz recording this is. One request resolves the recording, its
	// artist credit, ISRCs and releases — the search chain below exists only
	// for rows that have no id yet (or whose id lookup failed).
	if (query.recordingMbid) {
		const rec = await fetchRecordingByMbid(query.recordingMbid);
		if (rec) {
			const preferred = query.releaseMbid
				? (rec.releases ?? []).find((r) => r.id === query.releaseMbid)
				: undefined;
			const chosen = chosenForProven(rec, preferred);
			if (chosen) return withTrackNumbers(chosen, query);
		}
	}
	// A stored release id: its own track list already names this recording's
	// position — no second request for track numbers — and the artist credit
	// comes from the recording itself (one extra request, only on success).
	if (query.releaseMbid) {
		const release = await fetchReleaseByMbid(query.releaseMbid);
		const track = release ? trackOf(release, query.title) : null;
		if (release && track) {
			const rec =
				(await fetchRecordingByMbid(track.recordingId)) ??
				({
					id: track.recordingId,
					title: track.recordingTitle,
					'artist-credit': release['artist-credit'],
					releases: [release],
				} satisfies MbRecording);
			const chosen = chosenForProven(rec, release);
			if (chosen) {
				const patch = await toPatch(chosen, query.needed);
				if (query.needed.includes('trackNumber') && track.position != null)
					patch.trackNumber = track.position;
				if (query.needed.includes('discNumber') && track.disc != null)
					patch.discNumber = track.disc;
				if (query.needed.includes('releaseTrackMbid') && track.trackId)
					patch.releaseTrackMbid = track.trackId;
				return patch;
			}
		}
	}
	// ISRC first — authoritative, no fuzzy matching required.
	if (query.isrc) {
		const chosen = choose(await search(`isrc:${query.isrc}`), query);
		if (chosen) return withTrackNumbers(chosen, query);
	}
	let chosen = choose(
		await search(`recording:"${query.title}" AND artist:"${query.artist}"`),
		query,
	);
	if (!chosen) {
		// Widened candidates for a mistyped title, artist still constraining:
		// norm()-exact acceptance below keeps the extra hits harmless.
		const fuzzy = fuzzyTitleQuery(query.title);
		if (fuzzy) chosen = choose(await search(`${fuzzy} AND artist:"${query.artist}"`), query);
	}
	if (!chosen) {
		// Retry on title alone.
		//
		// A collaboration's artist field is the merged credit list — 'Ptite
		// Soeur, neophron, FEMTOGO, reivilose, prxpvne, rosaliedu38' — and
		// MusicBrainz will not match an artist query against a comma-separated
		// list of six names, so the FIRST search returns nothing and every
		// fallback behind it is unreachable. `choose` still applies every guard:
		// a strict match needs title+artist+duration, and the artwork-only path
		// requires an unambiguous exact title, and yields a cover and nothing else.
		chosen = choose(await search(`recording:"${query.title}"`), query);
	}
	if (!chosen && query.album) {
		// Retry with the album constraint: when the artist name is corrupted,
		// searching by title+album can find the recording even when it's not in
		// the top 25 title-only results. MusicBrainz knows the release, so
		// matching by release title is unambiguous for one-track-per-release cases.
		chosen = choose(
			await search(`recording:"${query.title}" AND release:"${query.album}"`),
			query,
		);
	}
	if (!chosen) {
		// Last widened rung, no artist constraint — for rows whose artist string
		// is ALSO wrong. Same guard class as the title-only rung above: one
		// norm()-exact unambiguous title, or nothing.
		const fuzzy = fuzzyTitleQuery(query.title);
		if (fuzzy) chosen = choose(await search(fuzzy), query);
	}
	if (!chosen) {
		log.debug('musicbrainz: no canonical release matched', {
			title: query.title,
			artist: query.artist,
		});
		return null;
	}
	return withTrackNumbers(chosen, query);
}

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
	const wantsReleaseTrack = query.needed.includes('releaseTrackMbid');
	if (!wantsTrack && !wantsDisc && !wantsReleaseTrack) return patch;
	const { trackNumber, discNumber, releaseTrackMbid } = await fetchTrackNumbers(
		chosen.release.id,
		chosen.recording.id,
		chosen.recording.title,
	);
	if (wantsTrack && trackNumber != null) patch.trackNumber = trackNumber;
	if (wantsDisc && discNumber != null) patch.discNumber = discNumber;
	if (wantsReleaseTrack && releaseTrackMbid) patch.releaseTrackMbid = releaseTrackMbid;
	return patch;
}
