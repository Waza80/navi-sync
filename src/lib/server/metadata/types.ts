/**
 * Metadata-only enrichment sources.
 *
 * These are NOT download providers: they expose catalog metadata (album,
 * album artist, year, genre, track/disc numbers, cover art) and never stream
 * audio. That keeps them free of DRM concerns — a plain catalog lookup, the
 * same thing Navidrome itself does.
 *
 * A `MetadataSource` only fills GAPS: `needed` tells it which fields are
 * missing so it can skip work (and rate limits) when nothing is required.
 */

export interface MetadataQuery {
	trackId: string;
	title: string;
	artist: string;
	/** Existing album, or null when the row has no album at all. */
	album: string | null;
	isrc: string | null;
	durationSec: number | null;
	year: number | null;
	/** Fields currently missing on the row — the source fills only these. */
	needed: MetadataField[];
	/** When present, the file's own embedded tags are consulted first. */
	filePath?: string | null;
}

/** Fields an enrichment source may fill. */
export type MetadataField =
	| 'album'
	| 'albumArtist'
	| 'coverUrl'
	| 'genre'
	| 'year'
	| 'trackNumber'
	| 'discNumber'
	| 'isrc'
	| 'artistMbid';

/** A partial metadata update — every key is optional and only set when known. */
export type MetadataPatch = Partial<{
	album: string | null;
	albumArtist: string | null;
	coverUrl: string | null;
	genre: string | null;
	year: number | null;
	trackNumber: number | null;
	discNumber: number | null;
	isrc: string | null;
	artistMbid: string | null;
}>;

/**
 * Fields MusicBrainz is the authority for, and which are therefore taken on its
 * word alone.
 *
 * The corroboration rule — settle a field by agreement between sources — exists
 * because every source is individually unreliable: measured over 12 albums,
 * Tidal was right 8/12, Deezer 7/11 and MusicBrainz 6/8, each wrong on a
 * different 3–4 albums. That reasoning does NOT apply to release facts. An
 * album's release date, label, catalogue number, status and format are not
 * opinions a streaming service forms; MusicBrainz either knows them or has no
 * answer, and where it does answer it is the record of fact. Requiring a second
 * source to agree would discard the best answer available.
 *
 * Deliberately EXCLUDED, which keep multi-source merging:
 *
 *   coverUrl — MusicBrainz has no artwork for some releases (measured: release
 *     3dec9a86… answers 404 for front, back and medium), so a second and third
 *     chance is worth real coverage.
 *   genre    — no source is authoritative and coverage is thin everywhere;
 *     merging claims is what produces a usable tag.
 */
export const AUTHORITATIVE_FIELDS: ReadonlySet<MetadataField> = new Set<MetadataField>([
	'album',
	'albumArtist',
	'isrc',
	'artistMbid',
	'year',
	'trackNumber',
	'discNumber',
]);

export const ALL_FIELDS: MetadataField[] = [
	'album',
	'albumArtist',
	'coverUrl',
	'genre',
	'year',
	'trackNumber',
	'discNumber',
	'isrc',
	'artistMbid',
];

export interface MetadataSource {
	id: string;
	displayName: string;
	/** Needs user-supplied credentials before it can answer anything. */
	requiresAuth: boolean;
	/** Fast lookup by exact ISRC — no fuzzy matching, so it is authoritative. */
	lookup(query: MetadataQuery): Promise<MetadataPatch | null>;
}

export function neededFieldsFor(
	row: {
		album: string | null;
		albumArtist: string | null;
		coverPath: string | null;
		genre: string | null;
		releaseYear: number | null;
		trackNumber: number | null;
		discNumber: number | null;
		isrc: string | null;
		/** Absent on rows written before the MBID column existed. */
		artistMbid?: string | null;
	},
	opts: { force?: boolean } = {},
): MetadataField[] {
	// A forced pass re-asks for EVERY field, not just the empty ones.
	//
	// The gap-only rule is what made wrong values permanent: the provider's album
	// release date is written into `year` at download time, and since the field was
	// then occupied, enrichment skipped it and MusicBrainz's date never got a vote.
	// La Memoire Insoluble sat at 2013 against a true 1998. Re-asking is the only
	// way a filled-but-wrong field can ever be corrected.
	if (opts.force) return ALL_FIELDS;
	// Whitespace-only strings count as missing — the "song with no album" case
	// often arrives as '' or '   ' rather than NULL.
	const missing = (v: string | null | undefined): boolean => v == null || v.trim() === '';
	const out: MetadataField[] = [];
	if (missing(row.album)) out.push('album');
	if (missing(row.albumArtist)) out.push('albumArtist');
	if (missing(row.coverPath)) out.push('coverUrl');
	if (missing(row.genre)) out.push('genre');
	if (row.releaseYear === null) out.push('year');
	if (row.trackNumber === null) out.push('trackNumber');
	if (row.discNumber === null) out.push('discNumber');
	if (missing(row.isrc)) out.push('isrc');
	if (missing(row.artistMbid)) out.push('artistMbid');
	return out;
}

/** Drops patch keys that are null/empty so they never overwrite good data. */
/**
 * Drop empty and unusable values from a patch.
 *
 * Iterates the patch's OWN keys rather than naming them. The previous version
 * called `put` once per field, which meant a field had to be added in two places
 * — the type and this list — and forgetting the second failed silently:
 * `artistMbid` was declared, MusicBrainz returned it, and the cleaner dropped it,
 * leaving 686 rows with a NULL artist_mbid and no error anywhere. There is now
 * no list to keep in step.
 */
export function cleanPatch(patch: MetadataPatch): MetadataPatch {
	const out: MetadataPatch = {};
	for (const [key, value] of Object.entries(patch) as [keyof MetadataPatch, unknown][]) {
		if (value === null || value === undefined) continue;
		if (typeof value === 'string' && value.trim().length === 0) continue;
		if (typeof value === 'number' && !Number.isFinite(value)) continue;
		if (typeof value !== 'string' && typeof value !== 'number') continue;
		(out as Record<string, unknown>)[key] = typeof value === 'string' ? value.trim() : value;
	}
	return out;
}

export function patchKeys(patch: MetadataPatch): MetadataField[] {
	return Object.keys(patch) as MetadataField[];
}
