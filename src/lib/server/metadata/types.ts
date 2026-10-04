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
	'album' | 'albumArtist' | 'coverUrl' | 'genre' | 'year' | 'trackNumber' | 'discNumber' | 'isrc';

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
}>;

export interface MetadataSource {
	id: string;
	displayName: string;
	/** Needs user-supplied credentials before it can answer anything. */
	requiresAuth: boolean;
	/** Fast lookup by exact ISRC — no fuzzy matching, so it is authoritative. */
	lookup(query: MetadataQuery): Promise<MetadataPatch | null>;
}

export function neededFieldsFor(row: {
	album: string | null;
	albumArtist: string | null;
	coverPath: string | null;
	genre: string | null;
	releaseYear: number | null;
	trackNumber: number | null;
	discNumber: number | null;
	isrc: string | null;
}): MetadataField[] {
	// Whitespace-only strings count as missing — the "song with no album" case
	// often arrives as '' or '   ' rather than NULL.
	const missing = (v: string | null): boolean => v == null || v.trim() === '';
	const out: MetadataField[] = [];
	if (missing(row.album)) out.push('album');
	if (missing(row.albumArtist)) out.push('albumArtist');
	if (missing(row.coverPath)) out.push('coverUrl');
	if (missing(row.genre)) out.push('genre');
	if (row.releaseYear === null) out.push('year');
	if (row.trackNumber === null) out.push('trackNumber');
	if (row.discNumber === null) out.push('discNumber');
	if (missing(row.isrc)) out.push('isrc');
	return out;
}

/** Drops patch keys that are null/empty so they never overwrite good data. */
export function cleanPatch(patch: MetadataPatch): MetadataPatch {
	const out: MetadataPatch = {};
	const put = <K extends keyof MetadataPatch>(key: K, value: MetadataPatch[K]): void => {
		if (value === null || value === undefined) return;
		if (typeof value === 'string' && value.trim().length === 0) return;
		if (typeof value === 'number' && !Number.isFinite(value)) return;
		out[key] = value;
	};
	put('album', patch.album);
	put('albumArtist', patch.albumArtist);
	put('coverUrl', patch.coverUrl);
	put('genre', patch.genre);
	put('year', patch.year);
	put('trackNumber', patch.trackNumber);
	put('discNumber', patch.discNumber);
	put('isrc', patch.isrc);
	return out;
}

export function patchKeys(patch: MetadataPatch): MetadataField[] {
	return Object.keys(patch) as MetadataField[];
}
