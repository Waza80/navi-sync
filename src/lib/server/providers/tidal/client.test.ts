import { describe, expect, it } from 'vitest';
import { tidalCoverUrl, toTidalTrack, TidalClient } from './client';

/**
 * Fixtures captured verbatim from a live hifi-api v2.10 instance (2026-10) so
 * these tests fail if Tidal's response shape ever shifts underneath us.
 */

/** GET /search/?s=Get+Lucky+Daft+Punk — one item of `{data:{items:[…]}}`. */
const SEARCH_ITEM = {
	id: 20115564,
	title: 'Get Lucky',
	version: null,
	isrc: 'USQX91300108',
	duration: 370,
	trackNumber: 8,
	volumeNumber: 1,
	releaseDate: null,
	artist: { id: 8847, name: 'Daft Punk' },
	artists: [
		{ id: 8847, name: 'Daft Punk' },
		{ id: 4900204, name: 'Pharrell Williams' },
		{ id: 30528, name: 'Nile Rodgers' },
	],
	album: {
		id: 20115556,
		title: 'Random Access Memories',
		cover: 'b66a5c40-c34d-4507-a0dc-5f98e46fdd20',
		releaseDate: '2013-05-20',
	},
	mediaMetadata: { tags: ['LOSSLESS'] },
};

/** GET /info/?id=20115564 — same track, album inlined, no releaseDate. */
const INFO_BODY = {
	version: '2.10',
	data: { ...SEARCH_ITEM },
};

/** GET /album/?id=20115556 — album with `{item: …}` relationship entries. */
const ALBUM_BODY = {
	version: '2.10',
	data: {
		id: 20115556,
		title: 'Random Access Memories',
		cover: 'b66a5c40-c34d-4507-a0dc-5f98e46fdd20',
		releaseDate: '2013-05-20',
		artist: { id: 8847, name: 'Daft Punk' },
		artists: [{ id: 8847, name: 'Daft Punk' }],
		items: [
			{
				item: {
					id: 20115557,
					title: 'Give Life Back to Music',
					duration: 275,
					trackNumber: 1,
					volumeNumber: 1,
					isrc: 'USQX91300101',
				},
			},
			{
				item: {
					id: 20115564,
					title: 'Get Lucky',
					duration: 370,
					trackNumber: 8,
					volumeNumber: 1,
					isrc: 'USQX91300108',
				},
			},
		],
	},
};

/** GET /track/?id=&quality= — base64 DASH MPD. */
const MPD = `<?xml version='1.0' encoding='UTF-8'?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
<Period id="0"><AdaptationSet id="0" contentType="audio">
<Representation id="FLAC,44100,16" codecs="flac" bandwidth="944871">
<SegmentTemplate timescale="44100" startNumber="1"
 initialization="https://cdn.test/init.mp4" media="https://cdn.test/$Number$.mp4">
<SegmentTimeline><S d="176128" r="91"/><S d="96760"/></SegmentTimeline>
</SegmentTemplate></Representation></AdaptationSet></Period></MPD>`;

/** fetch() receives a string, URL or Request — normalise all three safely. */
function urlOf(input: RequestInfo | URL): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function stubFetch(handler: (url: string) => { status?: number; body?: unknown }) {
	const original = globalThis.fetch;
	const seen: string[] = [];
	const stub: typeof fetch = (input: RequestInfo | URL) => {
		const url = urlOf(input);
		seen.push(url);
		const { status = 200, body = {} } = handler(url);
		return Promise.resolve(
			new Response(JSON.stringify(body), {
				status,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
	};
	globalThis.fetch = stub;
	return { seen, restore: () => (globalThis.fetch = original) };
}

const client = (url = 'https://hifi.test') => new TidalClient({ instanceUrl: url });

describe('tidalCoverUrl', () => {
	it('turns a cover id into a CDN URL with slashes, not dashes', () => {
		expect(tidalCoverUrl('b66a5c40-c34d-4507-a0dc-5f98e46fdd20')).toBe(
			'https://resources.tidal.com/images/b66a5c40/c34d/4507/a0dc/5f98e46fdd20/1280x1280.jpg',
		);
	});

	it('passes an absolute URL through untouched', () => {
		expect(tidalCoverUrl('https://example.test/a.jpg')).toBe('https://example.test/a.jpg');
	});

	it('returns null when there is no cover', () => {
		expect(tidalCoverUrl(null)).toBeNull();
		expect(tidalCoverUrl(undefined)).toBeNull();
		expect(tidalCoverUrl('')).toBeNull();
	});
});

describe('toTidalTrack', () => {
	it('maps a search item', () => {
		const t = toTidalTrack(SEARCH_ITEM);
		expect(t).toMatchObject({
			id: '20115564',
			title: 'Get Lucky',
			artist: 'Daft Punk',
			album: 'Random Access Memories',
			albumId: '20115556',
			albumArtist: 'Daft Punk',
			isrc: 'USQX91300108',
			durationSec: 370,
			trackNumber: 8,
			discNumber: 1,
			year: 2013,
		});
	});

	it('falls back to the album release date when the track has none', () => {
		// The live /info/ response has releaseDate: null on the track itself.
		expect(toTidalTrack(INFO_BODY.data).year).toBe(2013);
	});

	it('appends the version so the filename distinguishes editions', () => {
		expect(toTidalTrack({ id: 1, title: 'Song', version: 'Remastered' }).title).toBe(
			'Song (Remastered)',
		);
		// A null version must not leave a dangling "(null)".
		expect(toTidalTrack({ id: 1, title: 'Song', version: null }).title).toBe('Song');
	});

	it('uses the first artist as albumArtist on a collaboration', () => {
		expect(toTidalTrack(SEARCH_ITEM).albumArtist).toBe('Daft Punk');
	});

	it('does not invent a release year', () => {
		const t = toTidalTrack({ id: 1, title: 'X', releaseDate: null, album: { title: 'A' } });
		expect(t.year).toBeNull();
	});

	it('falls back to the album artist when the track has no artists array', () => {
		const t = toTidalTrack({
			id: 1,
			title: 'X',
			album: { title: 'A', artist: { name: 'Album Artist' } },
		});
		expect(t.artist).toBe('Album Artist');
		expect(t.albumArtist).toBe('Album Artist');
	});
});

describe('TidalClient.search', () => {
	it('unwraps the data envelope and maps items', async () => {
		const stub = stubFetch(() => ({
			body: { version: '2.10', data: { items: [SEARCH_ITEM] } },
		}));
		try {
			const out = await client().search('Get Lucky Daft Punk');
			expect(out).toHaveLength(1);
			expect(out[0]).toMatchObject({
				id: '20115564',
				title: 'Get Lucky',
				albumId: '20115556',
			});
		} finally {
			stub.restore();
		}
	});

	it('encodes the query', async () => {
		const stub = stubFetch(() => ({ body: { data: { items: [] } } }));
		try {
			await client().search('Daft Punk & Friends/');
			expect(stub.seen[0]).toContain('s=Daft%20Punk%20%26%20Friends%2F');
		} finally {
			stub.restore();
		}
	});

	it('tolerates an empty result set', async () => {
		const stub = stubFetch(() => ({ body: { data: { items: [] } } }));
		try {
			await expect(client().search('nothing at all')).resolves.toEqual([]);
		} finally {
			stub.restore();
		}
	});

	it('names the likely cause when the instance has no Tidal auth', async () => {
		const stub = stubFetch(() => ({
			status: 401,
			body: { detail: 'Tidal Auth Error: Token could not be verified' },
		}));
		try {
			await expect(client().search('x')).rejects.toThrow(/not authorized/);
		} finally {
			stub.restore();
		}
	});
});

describe('TidalClient.track', () => {
	it('reads bare-id metadata from /info/', async () => {
		const stub = stubFetch((url) =>
			url.includes('/info/') ? { body: INFO_BODY } : { body: {}, status: 404 },
		);
		try {
			const t = await client().track('20115564');
			expect(t).toMatchObject({ id: '20115564', title: 'Get Lucky', isrc: 'USQX91300108' });
		} finally {
			stub.restore();
		}
	});
});

describe('TidalClient.albumTracks', () => {
	it('unwraps the {item: …} relationship and inherits album context', async () => {
		const stub = stubFetch((url) =>
			url.includes('/album/') ? { body: ALBUM_BODY } : { body: {}, status: 404 },
		);
		try {
			const out = await client().albumTracks('20115556');
			expect(out.map((t) => t.id)).toEqual(['20115557', '20115564']);
			// Album title/cover/year come from the album, not the bare item.
			for (const t of out) {
				expect(t.album).toBe('Random Access Memories');
				expect(t.albumId).toBe('20115556');
				expect(t.year).toBe(2013);
				expect(t.artworkUrl).toContain('b66a5c40/c34d/');
			}
			expect(out[1]?.trackNumber).toBe(8);
		} finally {
			stub.restore();
		}
	});
});

describe('TidalClient.findByIsrc', () => {
	it('accepts an exact ISRC hit from the dedicated endpoint', async () => {
		const stub = stubFetch((url) =>
			url.includes('?i=')
				? { body: { data: { items: [SEARCH_ITEM] } } }
				: { body: {}, status: 404 },
		);
		try {
			const hit = await client().findByIsrc('USQX91300108');
			expect(hit?.id).toBe('20115564');
			// Only one request needed — no text-search fallback.
			expect(stub.seen).toHaveLength(1);
		} finally {
			stub.restore();
		}
	});

	it('falls back to text search and requires an exact ISRC match', async () => {
		const stub = stubFetch((url) => {
			if (url.includes('?i=')) return { body: { data: { items: [] } } };
			return { body: { data: { items: [SEARCH_ITEM] } } };
		});
		try {
			const hit = await client().findByIsrc('USQX91300108', 'Daft Punk', 'Get Lucky');
			expect(hit?.id).toBe('20115564');
			expect(stub.seen).toHaveLength(2);
		} finally {
			stub.restore();
		}
	});

	// Tidal reuses ISRCs across a release and its compilations — verified live:
	// USQX91300108 resolves to both Random Access Memories and a "Decade of
	// Summer" compilation. Filing the compilation would relocate the track.
	it('keeps the candidate from the requested album when an ISRC is duplicated', async () => {
		const COMPILATION = {
			...SEARCH_ITEM,
			id: 183655299,
			album: { ...SEARCH_ITEM.album, id: 183655282, title: 'Decade of Summer: The 10s' },
		};
		const stub = stubFetch(() => ({ body: { data: { items: [SEARCH_ITEM, COMPILATION] } } }));
		try {
			const hit = await client().findByIsrc('USQX91300108', 'Daft Punk', 'Get Lucky', {
				album: 'Random Access Memories',
			});
			expect(hit?.id).toBe('20115564');
			expect(hit?.album).toBe('Random Access Memories');
		} finally {
			stub.restore();
		}
	});

	it('disambiguates a duplicate ISRC by album id too', async () => {
		const COMPILATION = {
			...SEARCH_ITEM,
			id: 183655299,
			album: { ...SEARCH_ITEM.album, id: 183655282, title: 'Decade of Summer: The 10s' },
		};
		const stub = stubFetch(() => ({ body: { data: { items: [SEARCH_ITEM, COMPILATION] } } }));
		try {
			const hit = await client().findByIsrc('USQX91300108', 'Daft Punk', 'Get Lucky', {
				albumId: '183655282',
			});
			expect(hit?.id).toBe('183655299');
		} finally {
			stub.restore();
		}
	});

	it('refuses an ambiguous ISRC with no album context to disambiguate', async () => {
		const COMPILATION = {
			...SEARCH_ITEM,
			id: 183655299,
			album: { ...SEARCH_ITEM.album, id: 183655282, title: 'Decade of Summer: The 10s' },
		};
		const stub = stubFetch(() => ({ body: { data: { items: [SEARCH_ITEM, COMPILATION] } } }));
		try {
			await expect(
				client().findByIsrc('USQX91300108', 'Daft Punk', 'Get Lucky'),
			).resolves.toBeNull();
		} finally {
			stub.restore();
		}
	});

	it('refuses an ambiguous ISRC when the album hint matches neither candidate', async () => {
		const COMPILATION = {
			...SEARCH_ITEM,
			id: 183655299,
			album: { ...SEARCH_ITEM.album, id: 183655282, title: 'Decade of Summer: The 10s' },
		};
		const stub = stubFetch(() => ({ body: { data: { items: [SEARCH_ITEM, COMPILATION] } } }));
		try {
			await expect(
				client().findByIsrc('USQX91300108', 'Daft Punk', 'Get Lucky', {
					album: 'Some Other Album',
				}),
			).resolves.toBeNull();
		} finally {
			stub.restore();
		}
	});

	it('returns the only candidate when the ISRC is unique', async () => {
		const stub = stubFetch(() => ({ body: { data: { items: [SEARCH_ITEM] } } }));
		try {
			const hit = await client().findByIsrc('USQX91300108', 'Daft Punk', 'Get Lucky', {
				album: 'a completely different album',
			});
			// One exact match is unambiguous regardless of the hint.
			expect(hit?.id).toBe('20115564');
		} finally {
			stub.restore();
		}
	});

	it('returns null rather than guessing when nothing matches exactly', async () => {
		const stub = stubFetch((url) => {
			if (url.includes('?i=')) return { body: { data: { items: [] } } };
			return { body: { data: { items: [SEARCH_ITEM] } } };
		});
		try {
			// Right song, wrong recording — must not be accepted.
			await expect(
				client().findByIsrc('GBAYE0601498', 'Daft Punk', 'Get Lucky'),
			).resolves.toBeNull();
		} finally {
			stub.restore();
		}
	});

	it('rejects an ISRC endpoint hit whose isrc does not actually match', async () => {
		const stub = stubFetch(() => ({ body: { data: { items: [SEARCH_ITEM] } } }));
		try {
			await expect(client().findByIsrc('TOTALLYDIFFERENT1')).resolves.toBeNull();
		} finally {
			stub.restore();
		}
	});

	it('does not search at all with no artist/title context', async () => {
		const stub = stubFetch(() => ({ body: { data: { items: [] } } }));
		try {
			await expect(client().findByIsrc('USQX91300108')).resolves.toBeNull();
			expect(stub.seen).toHaveLength(1); // only the ISRC attempt
		} finally {
			stub.restore();
		}
	});
});

describe('TidalClient.resolve', () => {
	it('requests hi-res and returns a segment plan with real bit depth', async () => {
		const stub = stubFetch(() => ({
			body: {
				data: {
					audioQuality: 'LOSSLESS',
					bitDepth: 16,
					sampleRate: 44100,
					manifest: Buffer.from(MPD).toString('base64'),
				},
			},
		}));
		try {
			const res = await client().resolve('20115564', {
				preferLossless: true,
				minBitrateKbps: 320,
				allowLowerFallback: true,
			});
			expect(stub.seen[0]).toContain('quality=HI_RES_LOSSLESS');
			expect(res.format).toBe('flac');
			expect(res.cipher).toBe('NONE');
			// Reported by Tidal for this release, not guessed.
			expect(res.claimedBitDepth).toBe(16);
			expect(res.claimedLossless).toBe(true);
			expect(res.segments?.initUrl).toBe('https://cdn.test/init.mp4');
			expect(res.segments?.mediaUrls).toHaveLength(93);
			expect(res.segments?.mediaUrls[0]).toContain('00001.mp4');
		} finally {
			stub.restore();
		}
	});

	it('reports 24-bit hi-res honestly', async () => {
		const stub = stubFetch(() => ({
			body: {
				data: {
					audioQuality: 'HI_RES_LOSSLESS',
					bitDepth: 24,
					sampleRate: 192000,
					manifest: Buffer.from(MPD).toString('base64'),
				},
			},
		}));
		try {
			const res = await client().resolve('243175242', {
				preferLossless: true,
				minBitrateKbps: 320,
				allowLowerFallback: true,
			});
			expect(res.claimedBitDepth).toBe(24);
		} finally {
			stub.restore();
		}
	});

	it('skips hi-res when lossless is not preferred', async () => {
		const stub = stubFetch(() => ({
			body: {
				data: {
					audioQuality: 'LOW',
					bitDepth: null,
					manifest: Buffer.from(MPD).toString('base64'),
				},
			},
		}));
		try {
			const res = await client().resolve('1', {
				preferLossless: false,
				minBitrateKbps: 320,
				allowLowerFallback: true,
			});
			expect(stub.seen[0]).toContain('quality=LOW');
			expect(res.claimedLossless).toBe(false);
		} finally {
			stub.restore();
		}
	});

	it('falls back to a lower tier when the release has no hi-res master', async () => {
		const stub = stubFetch((url) =>
			// 404 = this release has no master at that quality.
			url.includes('HI_RES_LOSSLESS')
				? { body: { detail: 'not found' }, status: 404 }
				: {
						body: {
							data: {
								audioQuality: 'LOSSLESS',
								bitDepth: 16,
								manifest: Buffer.from(MPD).toString('base64'),
							},
						},
					},
		);
		try {
			const res = await client().resolve('1', {
				preferLossless: true,
				minBitrateKbps: 320,
				allowLowerFallback: true,
			});
			expect(res.claimedBitDepth).toBe(16);
			expect(stub.seen[0]).toContain('HI_RES_LOSSLESS');
			expect(stub.seen[1]).toContain('LOSSLESS');
		} finally {
			stub.restore();
		}
	});

	it('reports NO_STREAM when no tier yields a manifest', async () => {
		const stub = stubFetch(() => ({ status: 404, body: { detail: 'nope' } }));
		try {
			await expect(
				client().resolve('1', {
					preferLossless: true,
					minBitrateKbps: 320,
					allowLowerFallback: true,
				}),
			).rejects.toThrow(/No playable master/);
		} finally {
			stub.restore();
		}
	});
});
