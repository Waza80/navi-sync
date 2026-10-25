import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_FIELDS, cleanPatch, neededFieldsFor, patchKeys } from './types';
import { enrichTrackMetadata, metadataSources } from './index';
import { cooldownMsForStatus, musicbrainzSource } from './sources/musicbrainz';

describe('neededFieldsFor', () => {
	it('reports every gap on a bare row', () => {
		expect(
			neededFieldsFor({
				album: null,
				albumArtist: null,
				artist: null,
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
			'artistMbid',
			'artist',
			'coverUrl',
			'genre',
			'year',
			'trackNumber',
			'discNumber',
			'isrc',
			'recordingMbid',
			'releaseMbid',
			'releaseGroupMbid',
			'albumArtistMbid',
			'releaseTrackMbid',
		]);
	});

	it('reports nothing for a complete row', () => {
		expect(
			neededFieldsFor({
				album: 'Discovery',
				albumArtist: 'Daft Punk',
				artist: 'Daft Punk',
				coverPath: 'Daft Punk/Discovery/cover.jpg',
				genre: 'Electronic',
				releaseYear: 2001,
				trackNumber: 1,
				discNumber: 1,
				isrc: 'FR123400001',
				artistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
				recordingMbid: '85b66d88-2a30-4e3a-9a95-9e2e1f7c3d41',
				releaseMbid: '6d9f4e2b-1a3c-4d5e-8f9a-0b1c2d3e4f5a',
				releaseGroupMbid: '7e8f9a0b-1c2d-3e4f-5a6b-7c8d9e0f1a2b',
				albumArtistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
				releaseTrackMbid: '9a0b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d',
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
			artist: 'Tanger',
			coverPath: 'Tanger/La Memoire Insoluble/cover.jpg',
			genre: 'Rap',
			releaseYear: 2013,
			trackNumber: 4,
			discNumber: 1,
			isrc: 'FRZ039800080',
			artistMbid: '9ba3809e-86c4-4d47-b856-bd5bb2d9fe79',
			recordingMbid: '85b66d88-2a30-4e3a-9a95-9e2e1f7c3d41',
			releaseMbid: '6d9f4e2b-1a3c-4d5e-8f9a-0b1c2d3e4f5a',
			releaseGroupMbid: '7e8f9a0b-1c2d-3e4f-5a6b-7c8d9e0f1a2b',
			albumArtistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
			releaseTrackMbid: '9a0b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d',
		};
		expect(neededFieldsFor(complete)).toEqual([]);
		expect(neededFieldsFor(complete, { force: true })).toEqual(ALL_FIELDS);
	});

	it('tolerates rows written before the artist MBID column existed', () => {
		const legacy = {
			album: 'Discovery',
			albumArtist: 'Daft Punk',
			artist: 'Daft Punk',
			coverPath: 'x.jpg',
			genre: 'Electronic',
			releaseYear: 2001,
			trackNumber: 1,
			discNumber: 1,
			isrc: 'FR123400001',
		};
		expect(neededFieldsFor(legacy)).toEqual([
			'artistMbid',
			'artist',
			'recordingMbid',
			'releaseMbid',
			'releaseGroupMbid',
			'albumArtistMbid',
			'releaseTrackMbid',
		]);
	});

	// Regression: cleanPatch whitelists keys explicitly, and artistMbid was missing
	// from that list — so the resolver produced a perfectly good MBID and the
	// cleaner silently dropped it, leaving every row with a NULL artist_mbid.
	it('keeps artistMbid through cleanPatch', () => {
		const patch = cleanPatch({
			artistMbid: '9ba3809e-86c4-4d47-b856-bd5bb2d9fe79',
			album: 'La Mémoire insoluble',
		});
		expect(patch.artistMbid).toBe('9ba3809e-86c4-4d47-b856-bd5bb2d9fe79');
		expect(patchKeys(patch)).toContain('artistMbid');
	});

	it('drops an empty artistMbid rather than writing a blank identity', () => {
		expect(cleanPatch({ artistMbid: '   ' }).artistMbid).toBeUndefined();
	});

	it('treats a blank album as missing (the "song with no album" case)', () => {
		const fields = neededFieldsFor({
			album: '   ',
			albumArtist: 'Daft Punk',
			artist: 'Daft Punk',
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
			artist: 'Daft Punk',
			coverPath: null,
			genre: 'Electronic',
			releaseYear: 2001,
			trackNumber: 1,
			discNumber: 1,
			isrc: 'FR123400001',
			artistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
		});
		expect(fields).toEqual([
			'coverUrl',
			'recordingMbid',
			'releaseMbid',
			'releaseGroupMbid',
			'albumArtistMbid',
			'releaseTrackMbid',
		]);
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

describe('musicbrainz source (stubbed transport)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// The old constant parked the mirror for TEN MINUTES, so one 429 during a
	// reindex pinned every following request to the official host's 1 req/sec
	// throttle for the rest of the sweep. Operator policy: seconds, never minutes.
	it('parks a failing mirror for seconds, never minutes', () => {
		expect(cooldownMsForStatus(429)).toBe(2_000);
		expect(cooldownMsForStatus(401)).toBe(10_000);
		expect(cooldownMsForStatus(403)).toBe(10_000);
		expect(cooldownMsForStatus(500)).toBe(5_000);
		expect(cooldownMsForStatus(null)).toBe(5_000);
		expect(cooldownMsForStatus(429)).toBeLessThanOrEqual(10_000);
	});

	const json = (body: unknown): Response =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	const missing = (): Response => new Response('not found', { status: 404 });

	it('resolves a stored recording MBID with no search at all', { timeout: 15_000 }, async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown) => {
				const url = String(input);
				calls.push(url);
				await Promise.resolve();
				if (url.includes('/recording/') && !url.includes('query=')) {
					return json({
						id: '11111111-1111-1111-1111-111111111111',
						title: 'Zzqx Song',
						'artist-credit': [
							{
								name: 'Zzqx Artist',
								artist: { id: '33333333-3333-3333-3333-333333333333' },
							},
						],
						isrcs: ['QZDA0001'],
						releases: [
							{
								id: '22222222-2222-2222-2222-222222222222',
								title: 'Zzqx Album',
								status: 'Official',
								date: '2019-05-04',
								'release-group': {
									id: '44444444-4444-4444-4444-444444444444',
									'primary-type': 'Album',
								},
							},
						],
					});
				}
				return missing();
			}),
		);
		const patch = await musicbrainzSource.lookup({
			trackId: 't1',
			title: 'Zzqx Song',
			artist: 'Zzqx Artist',
			album: 'Zzqx Album',
			isrc: null,
			durationSec: 180,
			year: null,
			needed: ['artist', 'artistMbid', 'recordingMbid', 'releaseMbid', 'album', 'year'],
			recordingMbid: '11111111-1111-1111-1111-111111111111',
			releaseMbid: '22222222-2222-2222-2222-222222222222',
		});
		// A stored MBID is stronger evidence than any query: the search chain
		// (which cannot even run for rows with garbage artist strings) is skipped.
		expect(calls.filter((u) => u.includes('query='))).toHaveLength(0);
		expect(calls.length).toBeGreaterThan(0);
		expect(patch).toMatchObject({
			artist: 'Zzqx Artist',
			artistMbid: '33333333-3333-3333-3333-333333333333',
			recordingMbid: '11111111-1111-1111-1111-111111111111',
			releaseMbid: '22222222-2222-2222-2222-222222222222',
			album: 'Zzqx Album',
			year: 2019,
		});
	});

	it(
		'takes identity from an unofficial release but withholds album and year',
		{ timeout: 15_000 },
		async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: unknown) => {
					const url = String(input);
					await Promise.resolve();
					if (url.includes('query=')) {
						return json({
							recordings: [
								{
									id: '55555555-5555-5555-5555-555555555555',
									title: 'Zzqx Bootleg Song',
									length: 180_000,
									'artist-credit': [
										{
											name: 'Zzqx Artist',
											artist: { id: '66666666-6666-6666-6666-666666666666' },
										},
									],
									releases: [
										{
											id: '77777777-7777-7777-7777-777777777777',
											title: 'Zzqx Live Album',
											status: 'Bootleg',
											date: '2003',
											'release-group': {
												id: '88888888-8888-8888-8888-888888888888',
												'primary-type': 'Album',
												'secondary-types': ['Live'],
											},
										},
									],
								},
							],
						});
					}
					return missing();
				}),
			);
			const patch = await musicbrainzSource.lookup({
				trackId: 't2',
				title: 'Zzqx Bootleg Song',
				artist: 'Zzqx Artist',
				album: 'Zzqx Live Album',
				isrc: null,
				durationSec: 180,
				year: null,
				needed: ['artist', 'artistMbid', 'recordingMbid', 'album', 'year'],
			});
			// Identity (artist credit + MBIDs) is proven by the strict match and
			// flows even though the only release is a Bootleg...
			expect(patch).toMatchObject({
				artist: 'Zzqx Artist',
				artistMbid: '66666666-6666-6666-6666-666666666666',
				recordingMbid: '55555555-5555-5555-5555-555555555555',
			});
			// ...but an unofficial release must never rename the album or give a year.
			expect(patch?.album).toBeUndefined();
			expect(patch?.year).toBeUndefined();
		},
	);

	it(
		'pauses once on a burst-shaped 429 and still resolves the search',
		{ timeout: 15_000 },
		async () => {
			let searchCalls = 0;
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: unknown) => {
					const url = String(input);
					await Promise.resolve();
					if (url.includes('query=')) {
						searchCalls++;
						// First attempt is shed by the server, second succeeds — the
						// burst pattern MusicBrainz produces even at 1 req/sec.
						if (searchCalls === 1) return new Response('busy', { status: 429 });
						return json({
							recordings: [
								{
									id: '99999999-9999-9999-9999-999999999999',
									title: 'Zzqx Throttled Song',
									length: 180_000,
									'artist-credit': [
										{
											name: 'Zzqx Artist',
											artist: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
										},
									],
									releases: [
										{
											id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
											title: 'Zzqx Album',
											status: 'Official',
										},
									],
								},
							],
						});
					}
					return missing();
				}),
			);
			const patch = await musicbrainzSource.lookup({
				trackId: 't3',
				title: 'Zzqx Throttled Song',
				artist: 'Zzqx Artist',
				album: null,
				isrc: null,
				durationSec: 180,
				year: null,
				needed: ['artist', 'artistMbid', 'recordingMbid'],
			});
			// Exactly two attempts: one shed, one after the status-shaped pause.
			expect(searchCalls).toBe(2);
			expect(patch).toMatchObject({
				artist: 'Zzqx Artist',
				artistMbid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
				recordingMbid: '99999999-9999-9999-9999-999999999999',
			});
		},
	);

	it(
		'finds a mistyped title through the widened candidate rungs',
		{ timeout: 15_000 },
		async () => {
			const queries: string[] = [];
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: unknown) => {
					const url = decodeURIComponent(String(input));
					await Promise.resolve();
					const m = url.match(/query=([^&]+)/);
					const q = m?.[1] ?? '';
					queries.push(q);
					// Exact quoted phrases match neither the stored typo nor MB's copy —
					// return nothing, exactly like the live server does for them.
					if (q.includes('recording:"')) return missing();
					if (q.startsWith('recording:')) {
						// The widened rung finds the recording whose title MB spells
						// correctly; norm-equality downstream accepts it.
						return json({
							recordings: [
								{
									id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
									title: 'Il y a un ange',
									length: 244_000,
									'artist-credit': [
										{
											name: 'Tanger',
											artist: { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd' },
										},
									],
									releases: [
										{
											id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
											title: 'Le Detroit',
											status: 'Official',
										},
									],
								},
							],
						});
					}
					return missing();
				}),
			);
			const patch = await musicbrainzSource.lookup({
				trackId: 't4',
				title: 'Il ya un Ange', // stored typo — MB has "Il y a un ange"
				artist: 'Tanger',
				album: null,
				isrc: null,
				durationSec: 244,
				year: null,
				needed: ['artist', 'artistMbid', 'recordingMbid'],
			});
			// Exact rungs asked and got nothing; the widened rung found it.
			expect(queries.some((q) => q.includes('recording:"Il ya un Ange"'))).toBe(true);
			expect(queries).toContain('recording:ange AND artist:"Tanger"');
			expect(patch).toMatchObject({
				artist: 'Tanger',
				artistMbid: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
				recordingMbid: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
			});
		},
	);
});
