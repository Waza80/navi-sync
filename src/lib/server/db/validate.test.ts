import { describe, expect, it } from 'vitest';
import {
	DbInvariantError,
	NOT_A_TRACK_ID,
	assertValidTrackRow,
	libraryPath,
	safeValidateTrackRow,
	validateJobPayload,
} from './validate';
import { cleanPatch } from '$lib/server/metadata/types';

const ROW = {
	provider: 'deezer',
	providerTrackId: '2421366',
	title: 'Botox planétaire',
	artist: 'Tanger',
	album: "L'Amour fol",
	albumArtist: 'Tanger',
	isrc: 'FRZ030203540',
	trackNumber: 1,
	discNumber: 1,
	releaseYear: 2003,
	genre: 'Rap',
	durationSec: 214,
	format: 'flac',
	bitrateKbps: null,
	bitDepth: 16,
	sampleRateHz: 44100,
	isLossless: true,
	sizeBytes: 1234,
	checksumSha256: 'a'.repeat(64),
	filePath: '/music/Tanger/L-Amour fol/01 - Botox.flac',
	coverPath: null,
	downloadStatus: 'failed',
} as const;

describe('NOT_A_TRACK_ID', () => {
	it('accepts a provider-native id', () => {
		expect(NOT_A_TRACK_ID.safeParse('2421366').success).toBe(true);
		expect(NOT_A_TRACK_ID.safeParse('local:abc123').success).toBe(true);
	});

	// The bug that produced 29 rows titled "Failed download" by "Unknown Artist",
	// one storing "https://www.deezer.com/fr/artist/110750" as a track id. This
	// column is half a unique key, so a URL there forks the row instead of matching.
	it('rejects a URL', () => {
		const r = NOT_A_TRACK_ID.safeParse('https://www.deezer.com/track/2421366');
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error.issues[0].message).toMatch(/must not be a URL/);
	});

	it('rejects blank, padded and absurdly long ids', () => {
		expect(NOT_A_TRACK_ID.safeParse('').success).toBe(false);
		expect(NOT_A_TRACK_ID.safeParse(' 2421366').success).toBe(false);
		expect(NOT_A_TRACK_ID.safeParse('x'.repeat(201)).success).toBe(false);
	});
});

describe('libraryPath', () => {
	it('accepts a normal absolute path', () => {
		expect(libraryPath.safeParse('/music/Tanger/Album/01 - Song.lrc').success).toBe(true);
	});

	it('rejects traversal and NUL', () => {
		expect(libraryPath.safeParse('/music/../../etc/passwd').success).toBe(false);
		expect(libraryPath.safeParse('/music/..').success).toBe(false);
		// A real NUL byte, not the two characters "\" and "0".
		expect(libraryPath.safeParse(`/music/a${String.fromCharCode(0)}b`).success).toBe(false);
	});
});

describe('trackRowSchema', () => {
	it('accepts a well-formed row', () => {
		expect(safeValidateTrackRow(ROW)).not.toBeNull();
	});

	it('rejects a URL in provider_track_id', () => {
		expect(
			safeValidateTrackRow({ ...ROW, providerTrackId: 'https://x.test/track/1' }),
		).toBeNull();
	});

	it('rejects an ISRC that is not an ISRC', () => {
		expect(safeValidateTrackRow({ ...ROW, isrc: 'NOT-AN-ISRC' })).toBeNull();
		expect(safeValidateTrackRow({ ...ROW, isrc: null })).not.toBeNull();
	});

	it('rejects impossible years and track numbers', () => {
		expect(safeValidateTrackRow({ ...ROW, releaseYear: 1200 })).toBeNull();
		expect(safeValidateTrackRow({ ...ROW, releaseYear: 3000 })).toBeNull();
		expect(safeValidateTrackRow({ ...ROW, trackNumber: -1 })).toBeNull();
	});

	it('rejects an unknown download status', () => {
		expect(safeValidateTrackRow({ ...ROW, downloadStatus: 'pendingish' })).toBeNull();
	});

	it('assert throws with the field path so the bug is nameable', () => {
		try {
			assertValidTrackRow({ ...ROW, providerTrackId: 'https://x.test/track/1' });
			throw new Error('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(DbInvariantError);
			expect((err as Error).message).toContain('providerTrackId');
		}
	});
});

describe('validateJobPayload', () => {
	it('passes a well-formed download payload', () => {
		expect(validateJobPayload('download', { url: 'https://www.deezer.com/track/1' })).toEqual({
			url: 'https://www.deezer.com/track/1',
		});
	});

	it('rejects a download payload with no url', () => {
		expect(() => validateJobPayload('download', { provider: 'deezer' })).toThrow(
			DbInvariantError,
		);
	});

	it('rejects a non-uuid trackId', () => {
		expect(() => validateJobPayload('metadata_repair', { trackId: 'nope' })).toThrow(
			DbInvariantError,
		);
		expect(
			validateJobPayload('metadata_repair', {
				trackId: '3f2b8c14-9a7e-4d2b-8f31-6c5a0e9b1d47',
			}),
		).toEqual({
			trackId: '3f2b8c14-9a7e-4d2b-8f31-6c5a0e9b1d47',
		});
	});

	it('allows force on a repair, which the reindex relies on', () => {
		expect(
			validateJobPayload('metadata_repair', {
				trackId: '3f2b8c14-9a7e-4d2b-8f31-6c5a0e9b1d47',
				force: true,
			}),
		).toEqual({ trackId: '3f2b8c14-9a7e-4d2b-8f31-6c5a0e9b1d47', force: true });
	});

	it('leaves unknown job types alone rather than inventing a schema', () => {
		expect(validateJobPayload('some_future_type', { anything: 1 })).toEqual({ anything: 1 });
	});
});

describe('cleanPatch', () => {
	it('keeps every populated field, including ones added after the function was written', () => {
		// Regression: cleanPatch used to name fields one by one, so artistMbid was
		// declared, produced by MusicBrainz, and then dropped — 686 NULL rows and no
		// error anywhere. Iterating the patch's own keys removes the list to forget.
		const patch = cleanPatch({ album: 'X', artistMbid: 'mbid-1', year: 1998 });
		expect(patch).toEqual({ album: 'X', artistMbid: 'mbid-1', year: 1998 });
	});

	it('drops empty strings, null, undefined and non-finite numbers', () => {
		expect(cleanPatch({ album: '   ', artistMbid: null })).toEqual({});
		expect(cleanPatch({ year: Number.NaN })).toEqual({});
		expect(cleanPatch({ year: Number.POSITIVE_INFINITY })).toEqual({});
	});

	it('trims strings so surrounding whitespace cannot split a match', () => {
		expect(cleanPatch({ album: '  La Memoire Insoluble  ' })).toEqual({
			album: 'La Memoire Insoluble',
		});
	});
});

describe('job payloads survive validation', () => {
	// These are the exact payloads the routes and handlers send. A schema that
	// omits a key does not reject the job — zod STRIPS it, the handler reads
	// undefined, and the feature is silently inert while the caller is told it
	// enqueued. That is not hypothetical: `repair` was missing from the scan
	// schema, so the entire repair path never ran once.
	it('keeps every field the navidrome repair endpoint sends', () => {
		const sent = {
			repair: true,
			filesOnDisk: 675,
			tracksInDb: 675,
			missingFilesMarked: 0,
		};
		expect(validateJobPayload('navidrome_scan', sent)).toEqual(sent);
	});

	it('keeps the full-scan flag', () => {
		expect(validateJobPayload('navidrome_scan', { full: true })).toEqual({ full: true });
	});

	it('keeps a field-scoped metadata pass', () => {
		const sent = {
			trackId: '5cfb3294-70bf-430f-a0c9-3357770b80b4',
			reason: 'reindex:genre',
			force: true,
			fields: ['genre' as const],
		};
		expect(validateJobPayload('metadata_repair', sent)).toEqual(sent);
	});

	it('still rejects a metadata field that does not exist', () => {
		expect(() =>
			validateJobPayload('metadata_repair', {
				trackId: '5cfb3294-70bf-430f-a0c9-3357770b80b4',
				fields: ['nonsense'],
			}),
		).toThrow();
	});
});
