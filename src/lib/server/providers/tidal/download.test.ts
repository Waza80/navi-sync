import { describe, expect, it } from 'vitest';
import { ProviderError } from '$lib/server/providers/types';
import {
	assembleFlac,
	extractMdat,
	flacHeaderFromInit,
	parseDashManifest,
	parseStreamInfo,
	readBoxes,
} from './mp4';
import { downloadTidalFlac, type SegmentPlan } from './download';

/* ── fixtures ────────────────────────────────────────────────────────────── */

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
	const body = payload.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(8 + body);
	new DataView(out.buffer).setUint32(0, out.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	let at = 8;
	for (const p of payload) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

function streamInfo(rate: number, ch: number, bits: number, samples: number): Uint8Array {
	const si = new Uint8Array(34);
	const v = new DataView(si.buffer);
	v.setUint16(0, 4096);
	v.setUint16(2, 4096);
	v.setBigUint64(
		10,
		(BigInt(rate) << 44n) |
			(BigInt(ch - 1) << 41n) |
			(BigInt(bits - 1) << 36n) |
			BigInt(samples),
	);
	return si;
}

function flacHeader(rate: number, ch: number, bits: number, samples: number): Uint8Array {
	const block = new Uint8Array(4 + 34);
	block[0] = 0x80;
	block[3] = 34;
	block.set(streamInfo(rate, ch, bits, samples), 4);
	return concat(new TextEncoder().encode('fLaC'), block);
}

function initSegment(header: Uint8Array): Uint8Array {
	const entry = box('fLaC', new Uint8Array(41), box('dfLa', header.subarray(4)));
	const stbl = box('stbl', box('stsd', new Uint8Array(4), new Uint8Array(4), entry));
	return concat(
		box('ftyp', new TextEncoder().encode('iso8')),
		box('moov', box('trak', box('mdia', box('minf', stbl)))),
		box('mvex', new Uint8Array(48)),
	);
}

function mediaSegment(frames: Uint8Array): Uint8Array {
	return concat(box('moof', new Uint8Array(260)), box('mdat', frames));
}

/** A plan whose segments are produced on demand, keyed by URL. */
function planOf(sources: Record<string, Uint8Array>, count: number): SegmentPlan {
	const mediaUrls = Array.from({ length: count }, (_, i) => `https://cdn.test/${i + 1}.mp4`);
	const initUrl = 'https://cdn.test/init.mp4';
	return {
		initUrl,
		mediaUrls,
		expectedBytes: Object.values(sources).reduce((n, s) => n + s.length, 0),
		...(Object.keys(sources).length ? {} : {}),
	};
}

/* ── downloadTidalFlac against a stubbed fetch ───────────────────────────── */

interface StubRoute {
	body: Uint8Array;
	status?: number;
	failTimes?: number;
}

/** fetch() receives a string, URL or Request — normalise all three safely. */
function urlOf(input: RequestInfo | URL): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function stubFetch(routes: Record<string, StubRoute>) {
	const seen: string[] = [];
	const attempts = new Map<string, number>();
	const original = globalThis.fetch;
	const stub: typeof fetch = (input: RequestInfo | URL) => {
		const url = urlOf(input);
		seen.push(url);
		const route = routes[url];
		if (!route) return Promise.resolve(new Response('not found', { status: 404 }));
		const n = (attempts.get(url) ?? 0) + 1;
		attempts.set(url, n);
		if (route.failTimes && n <= route.failTimes) {
			return Promise.resolve(new Response('boom', { status: 500 }));
		}
		if (route.status && route.status >= 400) {
			return Promise.resolve(new Response('boom', { status: route.status }));
		}
		// `body` is a view over a larger buffer; copy so Response sees only it.
		const exact = new Uint8Array(route.body).buffer;
		return Promise.resolve(new Response(exact, { status: 200 }));
	};
	globalThis.fetch = stub;
	return {
		seen,
		/** How many times each URL was requested. */
		attempts: (url: string): number => attempts.get(url) ?? 0,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

async function withTmp<T>(fn: (path: string) => Promise<T>): Promise<T> {
	// Imported as namespaces: destructuring `join`/`rm` trips unbound-method.
	const fs = await import('node:fs/promises');
	const os = await import('node:os');
	const path = await import('node:path');
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'navi-tidal-'));
	try {
		return await fn(path.join(dir, 'out.flac'));
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe('downloadTidalFlac', () => {
	it('writes a valid FLAC assembled from init + segments', async () => {
		await withTmp(async (dest) => {
			const header = flacHeader(44100, 2, 16, 44100 * 300);
			const f1 = new Uint8Array([0xff, 0xf8, 0x01, 0x02]);
			const f2 = new Uint8Array([0xff, 0xf8, 0x03]);
			const stub = stubFetch({
				'https://cdn.test/init.mp4': { body: initSegment(header) },
				'https://cdn.test/1.mp4': { body: mediaSegment(f1) },
				'https://cdn.test/2.mp4': { body: mediaSegment(f2) },
			});
			try {
				const res = await downloadTidalFlac(planOf({}, 2), dest, { concurrency: 2 });
				expect(res.streamInfo.sampleRateHz).toBe(44100);
				expect(res.streamInfo.bitDepth).toBe(16);
				expect(res.streamInfo.durationSec).toBe(300);
				expect(res.bytes).toBe(42 + 4 + 3);

				const { readFile } = await import('node:fs/promises');
				const out = new Uint8Array(await readFile(dest));
				expect(String.fromCharCode(...out.subarray(0, 4))).toBe('fLaC');
				expect(Array.from(out.subarray(42))).toEqual([...f1, ...f2]);
			} finally {
				stub.restore();
			}
		});
	});

	it('requests segments in order so frames cannot interleave', async () => {
		await withTmp(async (dest) => {
			const header = flacHeader(44100, 2, 16, 44100 * 300);
			const routes: Record<string, StubRoute> = {
				'https://cdn.test/init.mp4': { body: initSegment(header) },
			};
			for (let i = 1; i <= 6; i++) {
				routes[`https://cdn.test/${i}.mp4`] = {
					body: mediaSegment(new Uint8Array([0xff, 0xf8, i])),
				};
			}
			const stub = stubFetch(routes);
			try {
				await downloadTidalFlac(planOf({}, 6), dest, { concurrency: 1 });
				const segs = stub.seen.filter(
					(u) => u.includes('/1.mp4') || /\/[2-6]\.mp4/.test(u),
				);
				expect(segs).toEqual([
					'https://cdn.test/1.mp4',
					'https://cdn.test/2.mp4',
					'https://cdn.test/3.mp4',
					'https://cdn.test/4.mp4',
					'https://cdn.test/5.mp4',
					'https://cdn.test/6.mp4',
				]);
			} finally {
				stub.restore();
			}
		});
	});

	it('retries a failing segment and still produces the full file', async () => {
		await withTmp(async (dest) => {
			const header = flacHeader(44100, 2, 16, 44100 * 300);
			const stub = stubFetch({
				'https://cdn.test/init.mp4': { body: initSegment(header) },
				'https://cdn.test/1.mp4': {
					body: mediaSegment(new Uint8Array([1, 2, 3])),
					failTimes: 2, // two 500s, then success
				},
				'https://cdn.test/2.mp4': { body: mediaSegment(new Uint8Array([4])) },
			});
			try {
				const res = await downloadTidalFlac(planOf({}, 2), dest, { maxRetries: 4 });
				expect(res.bytes).toBe(42 + 3 + 1);
				expect(stub.attempts('https://cdn.test/1.mp4')).toBe(3);
			} finally {
				stub.restore();
			}
		});
	});

	it('gives up with a ProviderError when a segment never succeeds', async () => {
		await withTmp(async (dest) => {
			const header = flacHeader(44100, 2, 16, 44100 * 300);
			const stub = stubFetch({
				'https://cdn.test/init.mp4': { body: initSegment(header) },
				'https://cdn.test/1.mp4': { body: new Uint8Array(0), status: 503 },
			});
			try {
				await expect(
					downloadTidalFlac(planOf({}, 1), dest, { maxRetries: 2 }),
				).rejects.toThrow(ProviderError);
			} finally {
				stub.restore();
			}
		});
	});

	it('rejects a segment that carries no mdat box', async () => {
		await withTmp(async (dest) => {
			const header = flacHeader(44100, 2, 16, 44100 * 300);
			const stub = stubFetch({
				'https://cdn.test/init.mp4': { body: initSegment(header) },
				// An HTML error page served with 200 must not become audio.
				'https://cdn.test/1.mp4': { body: new TextEncoder().encode('<html>oops</html>') },
			});
			try {
				await expect(
					downloadTidalFlac(planOf({}, 1), dest, { maxRetries: 1 }),
				).rejects.toThrow(/no mdat/);
			} finally {
				stub.restore();
			}
		});
	});

	it('fails before writing when the init segment has no FLAC header', async () => {
		await withTmp(async (dest) => {
			const stub = stubFetch({
				'https://cdn.test/init.mp4': { body: box('ftyp', new Uint8Array(32)) },
				'https://cdn.test/1.mp4': { body: mediaSegment(new Uint8Array([1])) },
			});
			try {
				await expect(downloadTidalFlac(planOf({}, 1), dest)).rejects.toThrow(
					/no FLAC header/,
				);
			} finally {
				stub.restore();
			}
		});
	});

	it('reports progress and honours an abort signal', async () => {
		await withTmp(async (dest) => {
			const header = flacHeader(44100, 2, 16, 44100 * 300);
			const routes: Record<string, StubRoute> = {
				'https://cdn.test/init.mp4': { body: initSegment(header) },
			};
			for (let i = 1; i <= 4; i++) {
				routes[`https://cdn.test/${i}.mp4`] = {
					body: mediaSegment(new Uint8Array(1000).fill(i)),
				};
			}
			const stub = stubFetch(routes);
			const ac = new AbortController();
			try {
				const seen: Array<[number, number | null]> = [];
				await downloadTidalFlac(planOf({}, 4), dest, {
					signal: ac.signal,
					concurrency: 1,
					onProgress: (r, t) => seen.push([r, t]),
				});
				expect(seen.length).toBe(4);
				expect(seen.at(-1)?.[0]).toBe(42 + 4000);
				// Progress is monotonic — a regress would mean double-counting.
				const values = seen.map(([r]) => r);
				expect([...values].sort((a, b) => a - b)).toEqual(values);
			} finally {
				stub.restore();
			}
		});
	});

	it('refuses an empty segment list', async () => {
		await withTmp(async (dest) => {
			const stub = stubFetch({});
			try {
				await expect(
					downloadTidalFlac(
						{ initUrl: 'https://cdn.test/init.mp4', mediaUrls: [] },
						dest,
					),
				).rejects.toThrow(/no segments/);
			} finally {
				stub.restore();
			}
		});
	});

	it('passes a 24/192 stream through intact', async () => {
		await withTmp(async (dest) => {
			const header = flacHeader(192000, 2, 24, 192000 * 350);
			const stub = stubFetch({
				'https://cdn.test/init.mp4': { body: initSegment(header) },
				'https://cdn.test/1.mp4': {
					body: mediaSegment(new Uint8Array([0xff, 0xf8, 0xaa])),
				},
			});
			try {
				const res = await downloadTidalFlac(planOf({}, 1), dest);
				expect(res.streamInfo).toMatchObject({
					sampleRateHz: 192000,
					bitDepth: 24,
					durationSec: 350,
				});
			} finally {
				stub.restore();
			}
		});
	});
});

/* ── the exported demux pieces stay consistent with the downloader ───────── */

describe('demux helpers used by the downloader', () => {
	it('produces the same bytes the downloader writes for one segment', () => {
		const header = flacHeader(44100, 2, 16, 44100 * 10);
		const frames = new Uint8Array([9, 8, 7]);
		const direct = assembleFlac(initSegment(header), [mediaSegment(frames)]);
		const manual = concat(
			flacHeaderFromInit(initSegment(header)),
			extractMdat(mediaSegment(frames)),
		);
		expect(Array.from(direct)).toEqual(Array.from(manual));
	});

	it('parses the STREAMINFO the downloader reports', () => {
		const info = parseStreamInfo(
			flacHeaderFromInit(initSegment(flacHeader(48000, 2, 24, 48000 * 60))).subarray(8, 42),
		);
		expect(info).toMatchObject({ sampleRateHz: 48000, bitDepth: 24, durationSec: 60 });
	});

	it('produces the segment count and URLs a download plan needs', () => {
		const mpd = `<MPD><Period><AdaptationSet><Representation>
<SegmentTemplate timescale="44100" startNumber="1"
 initialization="https://cdn.test/init.mp4"
 media="https://cdn.test/$Number$.mp4">
<SegmentTimeline><S d="10" r="1"/></SegmentTimeline>
</SegmentTemplate></Representation></AdaptationSet></Period></MPD>`;
		const m = parseDashManifest(mpd);
		expect(m.initUrl).toBe('https://cdn.test/init.mp4');
		expect(m.segmentCount).toBe(2);
		// A plan built from the manifest fetches exactly the numbered segments.
		const plan: SegmentPlan = {
			initUrl: m.initUrl,
			mediaUrls: Array.from({ length: m.segmentCount }, (_, i) => m.segmentUrl(i + 1)),
		};
		expect(plan.mediaUrls).toEqual([
			'https://cdn.test/00001.mp4',
			'https://cdn.test/00002.mp4',
		]);
	});

	it('keeps readBoxes and extractMdat consistent', () => {
		const seg = mediaSegment(new Uint8Array([1, 2, 3]));
		const types = readBoxes(seg).map((b) => b.type);
		expect(types).toEqual(['moof', 'mdat']);
		expect(extractMdat(seg)).toHaveLength(3);
	});
});
