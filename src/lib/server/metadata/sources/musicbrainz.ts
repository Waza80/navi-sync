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
	'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>;
}

/** Primary types that represent a real, canonical studio release. */
const CANONICAL_TYPES = new Set(['Album', 'Single']);

interface Chosen {
	recording: MbRecording;
	release: MbRelease;
	albumArtist: string | null;
}

function yearOf(date: string | undefined): number | null {
	const m = /^(\d{4})/.exec(date ?? '');
	if (!m?.[1]) return null;
	const y = Number.parseInt(m[1], 10);
	return Number.isFinite(y) ? y : null;
}

function coverUrlFor(releaseId: string | undefined): string | null {
	if (!releaseId) return null;
	return `https://coverartarchive.org/release/${releaseId}/front-1200`;
}

function artistName(rec: MbRecording): string | null {
	return rec['artist-credit']?.[0]?.name ?? rec['artist-credit']?.[0]?.artist?.name ?? null;
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

function toPatch(chosen: Chosen, needed: MetadataQuery['needed']): MetadataPatch {
	const { recording: rec, release } = chosen;
	return {
		...(needed.includes('album') && release.title ? { album: release.title } : {}),
		...(needed.includes('albumArtist') && chosen.albumArtist
			? { albumArtist: chosen.albumArtist }
			: {}),
		...(needed.includes('coverUrl') ? { coverUrl: coverUrlFor(release.id) } : {}),
		...(needed.includes('year') ? { year: yearOf(release.date) } : {}),
		...(needed.includes('trackNumber') && release.media?.[0]?.position
			? { trackNumber: release.media[0].position }
			: {}),
		...(needed.includes('discNumber') && release.media?.[0]?.position
			? { discNumber: release.media[0].position }
			: {}),
		...(needed.includes('isrc') && rec.isrcs?.[0] ? { isrc: rec.isrcs[0] } : {}),
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

export const musicbrainzSource: MetadataSource = {
	id: 'musicbrainz',
	displayName: 'MusicBrainz',
	requiresAuth: false,
	async lookup(query: MetadataQuery): Promise<MetadataPatch | null> {
		// ISRC first — authoritative, no fuzzy matching required.
		if (query.isrc) {
			const chosen = choose(await search(`isrc:${query.isrc}`), query);
			if (chosen) return toPatch(chosen, query.needed);
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
		return toPatch(chosen, query.needed);
	},
};
