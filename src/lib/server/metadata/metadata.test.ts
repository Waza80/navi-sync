import { describe, expect, it } from 'vitest';
import { ALL_FIELDS, cleanPatch, neededFieldsFor, patchKeys } from './types';
import { enrichTrackMetadata, metadataSources } from './index';

describe('neededFieldsFor', () => {
	it('reports every gap on a bare row', () => {
		expect(
			neededFieldsFor({
				album: null,
				albumArtist: null,
				coverPath: null,
				genre: null,
				releaseYear: null,
				trackNumber: null,
				discNumber: null,
				isrc: null,
			}),
		).toEqual([
			'album',
			'albumArtist',
			'coverUrl',
			'genre',
			'year',
			'trackNumber',
			'discNumber',
			'isrc',
			'artistMbid',
		]);
	});

	it('reports nothing for a complete row', () => {
		expect(
			neededFieldsFor({
				album: 'Discovery',
				albumArtist: 'Daft Punk',
				coverPath: 'Daft Punk/Discovery/cover.jpg',
				genre: 'Electronic',
				releaseYear: 2001,
				trackNumber: 1,
				discNumber: 1,
				isrc: 'FR123400001',
				artistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
			}),
		).toEqual([]);
	});

	// A filled-but-wrong field is invisible to the gap rule, and that is how a
	// wrong release year became permanent: the provider's album date occupied
	// `year` at download time, so enrichment skipped it forever.
	it('re-asks for every field when forced, however complete the row is', () => {
		const complete = {
			album: 'La Memoire Insoluble',
			albumArtist: 'Tanger',
			coverPath: 'Tanger/La Memoire Insoluble/cover.jpg',
			genre: 'Rap',
			releaseYear: 2013,
			trackNumber: 4,
			discNumber: 1,
			isrc: 'FRZ039800080',
			artistMbid: '9ba3809e-86c4-4d47-b856-bd5bb2d9fe79',
		};
		expect(neededFieldsFor(complete)).toEqual([]);
		expect(neededFieldsFor(complete, { force: true })).toEqual(ALL_FIELDS);
	});

	it('tolerates rows written before the artist MBID column existed', () => {
		const legacy = {
			album: 'Discovery',
			albumArtist: 'Daft Punk',
			coverPath: 'x.jpg',
			genre: 'Electronic',
			releaseYear: 2001,
			trackNumber: 1,
			discNumber: 1,
			isrc: 'FR123400001',
		};
		expect(neededFieldsFor(legacy)).toEqual(['artistMbid']);
	});

	it('treats a blank album as missing (the "song with no album" case)', () => {
		const fields = neededFieldsFor({
			album: '   ',
			albumArtist: 'Daft Punk',
			coverPath: 'x.jpg',
			genre: 'Electronic',
			releaseYear: 2001,
			trackNumber: 1,
			discNumber: 1,
			isrc: 'FR123400001',
		});
		expect(fields).toContain('album');
	});

	it('flags a broken cover even when everything else is present', () => {
		const fields = neededFieldsFor({
			album: 'Discovery',
			albumArtist: 'Daft Punk',
			coverPath: null,
			genre: 'Electronic',
			releaseYear: 2001,
			trackNumber: 1,
			discNumber: 1,
			isrc: 'FR123400001',
			artistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
		});
		expect(fields).toEqual(['coverUrl']);
	});
});

describe('cleanPatch', () => {
	it('drops null, undefined and empty values so good data is never blanked', () => {
		expect(
			cleanPatch({
				album: 'Discovery',
				albumArtist: null,
				genre: '',
				year: undefined,
				trackNumber: null,
			}),
		).toEqual({ album: 'Discovery' });
	});

	it('keeps zero and other valid numbers', () => {
		expect(cleanPatch({ trackNumber: 0, discNumber: 1 })).toEqual({
			trackNumber: 0,
			discNumber: 1,
		});
	});

	it('drops non-finite numbers', () => {
		expect(cleanPatch({ year: Number.NaN })).toEqual({});
	});

	it('returns an empty patch for an empty input', () => {
		expect(cleanPatch({})).toEqual({});
	});
});

describe('patchKeys', () => {
	it('lists the fields a patch would write', () => {
		expect(patchKeys({ album: 'X', year: 1999 }).sort()).toEqual(['album', 'year']);
	});
});

describe('enrichTrackMetadata', () => {
	it('queries sources in a stable order: strict catalog first, artwork last', () => {
		// Order is only the tie-break — every source is asked, and a value two of
		// them agree on wins outright. MusicBrainz leads because it is the only
		// strict source and the only one exposing `genre`.
		expect(metadataSources.map((s) => s.id)).toEqual([
			'musicbrainz',
			'tidal',
			'deezer',
			'itunes',
		]);
	});

	// NB: both of these consult every live metadata source, and MusicBrainz paces
	// itself at ~1 request/second, so the default 5s budget is not realistic for
	// them. They are integration tests by nature.
	it('consults the file own tags before any external source', { timeout: 30_000 }, async () => {
		// A real FLAC carries its own album — readFileTags wins and MusicBrainz
		// is never asked for it.
		const result = await enrichTrackMetadata({
			trackId: 't0',
			title: 'One More Time',
			artist: 'Daft Punk',
			album: null,
			isrc: 'GBDUW0600059',
			durationSec: 320,
			year: null,
			needed: ['album'],
			filePath: 'NO_SUCH_FILE.flac',
		});
		// The file is unreadable here, so it falls through to MusicBrainz —
		// but 'file' is still recorded as tried first.
		expect(result.tried[0]).toBe('file');
		expect(result.tried).toContain('musicbrainz');
	});

	it('never throws and reports what it tried', { timeout: 30_000 }, async () => {
		const result = await enrichTrackMetadata({
			trackId: 't1',
			title: 'Zzqx Nonexistent Title 12345',
			artist: 'Zzqx Nonexistent Artist 98765',
			album: null,
			isrc: null,
			durationSec: null,
			year: null,
			needed: ['album', 'coverUrl'],
		});
		expect(result.tried.length).toBeGreaterThan(0);
		expect(typeof result.patch).toBe('object');
		expect(result.filledBy).toBeTypeOf('object');
	});

	it('returns an empty patch when nothing is needed', async () => {
		const result = await enrichTrackMetadata({
			trackId: 't2',
			title: 'Anything',
			artist: 'Anyone',
			album: 'Album',
			isrc: 'FR1',
			durationSec: 200,
			year: 2001,
			needed: [],
		});
		expect(result.patch).toEqual({});
		expect(result.tried).toEqual([]);
	});
});
