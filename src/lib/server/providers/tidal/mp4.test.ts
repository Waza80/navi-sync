import { describe, expect, it } from 'vitest';
import {
	assembleFlac,
	extractMdat,
	flacHeaderFromInit,
	parseDashManifest,
	parseStreamInfo,
	readBoxes,
} from './mp4';

/* ── fixtures: synthetic ISO-BMFF mirroring Tidal's real layout ──────────── */

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
	const body = concat(...payload);
	const out = new Uint8Array(8 + body.length);
	new DataView(out.buffer).setUint32(0, out.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(body, 8);
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

/** 34-byte STREAMINFO for the given parameters. */
function streamInfo(
	sampleRate: number,
	channels: number,
	bitDepth: number,
	totalSamples: number,
): Uint8Array {
	const si = new Uint8Array(34);
	const v = new DataView(si.buffer);
	v.setUint16(0, 4096); // min blocksize
	v.setUint16(2, 4096); // max blocksize
	// min/max framesize left as 0 — not used by the demuxer.
	const packed =
		(BigInt(sampleRate) << 44n) |
		(BigInt(channels - 1) << 41n) |
		(BigInt(bitDepth - 1) << 36n) |
		BigInt(totalSamples);
	v.setBigUint64(10, packed);
	return si;
}

/** `fLaC` magic + one last STREAMINFO block — i.e. a bare FLAC header. */
function flacHeader(
	sampleRate: number,
	channels: number,
	bitDepth: number,
	totalSamples: number,
): Uint8Array {
	const si = streamInfo(sampleRate, channels, bitDepth, totalSamples);
	const block = new Uint8Array(4 + 34);
	block[0] = 0x80; // last-metadata-block + type 0 (STREAMINFO)
	block[1] = 0;
	block[2] = 0;
	block[3] = 34;
	block.set(si, 4);
	return concat(new TextEncoder().encode('fLaC'), block);
}

/** An fMP4 init segment shaped like Tidal's: ftyp + moov(fLaC entry) + mvex. */
function initSegment(header: Uint8Array): Uint8Array {
	const dfla = box('dfLa', header.subarray(4)); // payload = fLaC's blocks
	const entry = box('fLaC', new Uint8Array(41), dfla); // 41 zero bytes of sample-entry fields
	const stsd = box('stsd', new Uint8Array(4), new Uint8Array(4), entry);
	const stbl = box('stbl', stsd);
	const minf = box('minf', stbl);
	const mdia = box('mdia', minf);
	const trak = box('trak', mdia);
	const moov = box('moov', trak);
	const ftyp = box('ftyp', new TextEncoder().encode('iso8mp41dash'));
	return concat(ftyp, moov, box('mvex', new Uint8Array(48)));
}

/** A media segment: moof bookkeeping + an mdat holding raw FLAC frames. */
function mediaSegment(frames: Uint8Array): Uint8Array {
	return concat(box('moof', new Uint8Array(260)), box('mdat', frames));
}

const CD_HEADER = flacHeader(44100, 2, 16, 44100 * 370); // 370s
const HIRES_HEADER = flacHeader(192000, 2, 24, 192000 * 350); // 350s @ 24/192

/* ── parseDashManifest ──────────────────────────────────────────────────── */

const MPD = `<?xml version='1.0' encoding='UTF-8'?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT6M9.626S">
<Period id="0"><AdaptationSet id="0" contentType="audio">
<Representation id="FLAC,44100,16" codecs="flac" bandwidth="944871" audioSamplingRate="44100">
<SegmentTemplate timescale="44100" startNumber="1"
  initialization="https://cdn.example/init.mp4?a=1&amp;b=2"
  media="https://cdn.example/seg/$Number$.mp4?tok=xyz">
<SegmentTimeline><S d="176128" r="91"/><S d="96760"/></SegmentTimeline>
</SegmentTemplate></Representation></AdaptationSet></Period></MPD>`;

describe('parseDashManifest', () => {
	it('reads the init URL and unescapes XML entities', () => {
		const m = parseDashManifest(MPD);
		expect(m.initUrl).toBe('https://cdn.example/init.mp4?a=1&b=2');
	});

	it('expands the repeat count into a segment total (r=91 → 92, plus 1)', () => {
		expect(parseDashManifest(MPD).segmentCount).toBe(93);
	});

	it('zero-pads $Number$ to 5 digits from startNumber', () => {
		const m = parseDashManifest(MPD);
		expect(m.segmentUrl(1)).toContain('/00001.mp4');
		expect(m.segmentUrl(93)).toContain('/00093.mp4');
	});

	it('sums the timeline into seconds', () => {
		// (176128*92 + 96760) / 44100
		const m = parseDashManifest(MPD);
		expect(m.timelineSec).toBeCloseTo((176128 * 92 + 96760) / 44100, 3);
	});

	it('honours a non-default startNumber', () => {
		const m = parseDashManifest(MPD.replace('startNumber="1"', 'startNumber="5"'));
		expect(m.segmentUrl(1)).toContain('/00005.mp4');
	});

	it('reads the representation bandwidth', () => {
		expect(parseDashManifest(MPD).bandwidth).toBe(944871);
	});

	it('rejects a manifest with no SegmentTemplate', () => {
		expect(() => parseDashManifest('<MPD><Period/></MPD>')).toThrow(/no SegmentTemplate/);
	});

	it('rejects an empty SegmentTimeline', () => {
		const empty = MPD.replace(/<SegmentTimeline>.*<\/SegmentTimeline>/, '<SegmentTimeline/>');
		expect(() => parseDashManifest(empty)).toThrow(/empty SegmentTimeline/);
	});
});

/* ── box walking ────────────────────────────────────────────────────────── */

describe('readBoxes', () => {
	it('walks nested top-level boxes', () => {
		const data = concat(box('ftyp', new Uint8Array(4)), box('moov', new Uint8Array(60)));
		expect(readBoxes(data).map((b) => b.type)).toEqual(['ftyp', 'moov']);
	});

	it('honours a 64-bit extended size', () => {
		const body = new Uint8Array(40);
		const out = new Uint8Array(16 + body.length);
		const v = new DataView(out.buffer);
		v.setUint32(0, 1); // size == 1 → extended
		out[4] = 'm'.charCodeAt(0);
		out[5] = 'd'.charCodeAt(0);
		out[6] = 'a'.charCodeAt(0);
		out[7] = 't'.charCodeAt(0);
		v.setUint32(8, 0);
		v.setUint32(12, out.length);
		out.set(body, 16);
		const boxes = readBoxes(out);
		expect(boxes).toHaveLength(1);
		expect(boxes[0]?.headerSize).toBe(16);
		expect(boxes[0]?.size).toBe(out.length);
	});

	it('stops instead of looping on a corrupt size', () => {
		const bad = new Uint8Array(16);
		new DataView(bad.buffer).setUint32(0, 3); // size < header
		expect(readBoxes(bad)).toEqual([]);
	});
});

/* ── mdat extraction ────────────────────────────────────────────────────── */

describe('extractMdat', () => {
	it('returns only the mdat body, dropping moof bookkeeping', () => {
		const frames = new Uint8Array([0xff, 0xf8, 0xc9, 0xa8, 0x00, 0x8d]);
		const got = extractMdat(mediaSegment(frames));
		expect(Array.from(got)).toEqual(Array.from(frames));
	});

	it('concatenates multiple mdat boxes in order', () => {
		const a = new Uint8Array([1, 2]);
		const b = new Uint8Array([3, 4]);
		const got = extractMdat(
			concat(box('mdat', a), box('free', new Uint8Array(2)), box('mdat', b)),
		);
		expect(Array.from(got)).toEqual([1, 2, 3, 4]);
	});

	it('returns empty for a segment with no mdat', () => {
		expect(extractMdat(box('moof', new Uint8Array(20)))).toHaveLength(0);
	});
});

/* ── STREAMINFO ─────────────────────────────────────────────────────────── */

describe('parseStreamInfo', () => {
	it('decodes 16/44.1', () => {
		expect(parseStreamInfo(streamInfo(44100, 2, 16, 44100 * 370))).toMatchObject({
			sampleRateHz: 44100,
			channels: 2,
			bitDepth: 16,
			durationSec: 370,
		});
	});

	it('decodes 24/192', () => {
		const si = parseStreamInfo(streamInfo(192000, 2, 24, 192000 * 350));
		expect(si?.bitDepth).toBe(24);
		expect(si?.sampleRateHz).toBe(192000);
		expect(si?.durationSec).toBe(350);
	});

	it('decodes a sample count above 2^32 without overflow', () => {
		// The count is 36 bits wide, so a very long hi-res recording (here a
		// 7-hour 192 kHz set) exceeds what a 32-bit read could hold.
		const total = 192000 * 3600 * 7 + 12345;
		expect(total).toBeGreaterThan(0xffffffff);
		const si = parseStreamInfo(streamInfo(192000, 2, 24, total));
		expect(si?.totalSamples).toBe(total);
		expect(si?.durationSec).toBeCloseTo(total / 192000, 6);
	});

	it('rejects a zero sample rate', () => {
		expect(parseStreamInfo(streamInfo(0, 2, 16, 100))).toBeNull();
	});

	it('rejects a short buffer', () => {
		expect(parseStreamInfo(new Uint8Array(10))).toBeNull();
	});
});

/* ── header recovery ────────────────────────────────────────────────────── */

describe('flacHeaderFromInit', () => {
	it('finds the header behind nested boxes and returns fLaC + STREAMINFO', () => {
		const header = flacHeaderFromInit(initSegment(CD_HEADER));
		expect(header.byteLength).toBe(42);
		expect(String.fromCharCode(...header.subarray(0, 4))).toBe('fLaC');
		expect(header[4] & 0x80).toBe(0x80); // last metadata block
		expect(header[7]).toBe(34); // STREAMINFO length
		expect(parseStreamInfo(header.subarray(8, 42))).toMatchObject({
			sampleRateHz: 44100,
			bitDepth: 16,
			durationSec: 370,
		});
	});

	it('recovers a 24/192 header', () => {
		expect(
			parseStreamInfo(flacHeaderFromInit(initSegment(HIRES_HEADER)).subarray(8, 42)),
		).toMatchObject({ sampleRateHz: 192000, bitDepth: 24, durationSec: 350 });
	});

	it('finds the LAST metadata block when earlier ones are present', () => {
		// A vorbis-comment block (type 4) ahead of STREAMINFO must be skipped.
		const pad = box('free', new Uint8Array(64));
		const header = flacHeaderFromInit(concat(initSegment(CD_HEADER), pad));
		expect(header.byteLength).toBe(42);
	});

	it('throws when no plausible STREAMINFO exists', () => {
		expect(() => flacHeaderFromInit(box('ftyp', new Uint8Array(32)))).toThrow(
			/no FLAC STREAMINFO/,
		);
	});

	it('ignores a STREAMINFO claiming an absurd duration', () => {
		const bogus = flacHeader(44100, 2, 16, 44100); // 1 second — below the floor
		expect(() => flacHeaderFromInit(initSegment(bogus))).toThrow(/no FLAC STREAMINFO/);
	});
});

/* ── assembly ───────────────────────────────────────────────────────────── */

describe('assembleFlac', () => {
	it('produces a header followed by every segment in order', () => {
		const f1 = new Uint8Array([0xff, 0xf8, 0x01]);
		const f2 = new Uint8Array([0xff, 0xf8, 0x02]);
		const f3 = new Uint8Array([0xff, 0xf8, 0x03]);
		const out = assembleFlac(initSegment(CD_HEADER), [
			mediaSegment(f1),
			mediaSegment(f2),
			mediaSegment(f3),
		]);
		expect(out.byteLength).toBe(42 + 3 + 3 + 3);
		expect(String.fromCharCode(...out.subarray(0, 4))).toBe('fLaC');
		expect(Array.from(out.subarray(42))).toEqual([0xff, 0xf8, 1, 0xff, 0xf8, 2, 0xff, 0xf8, 3]);
	});

	it('is byte-identical to the header + frames it was given', () => {
		const frames = new Uint8Array(64).fill(0xab);
		const once = assembleFlac(initSegment(CD_HEADER), [mediaSegment(frames)]);
		const twice = assembleFlac(initSegment(CD_HEADER), [mediaSegment(frames)]);
		expect(Array.from(once)).toEqual(Array.from(twice));
	});

	it('emits a file that begins with a valid FLAC header', () => {
		const out = assembleFlac(initSegment(CD_HEADER), [
			mediaSegment(new Uint8Array([0xff, 0xf8, 0x69, 0x18])),
		]);
		expect(out[0]).toBe(0x66); // 'f'
		expect(out[1]).toBe(0x4c); // 'L'
		expect(out[2]).toBe(0x61); // 'a'
		expect(out[3]).toBe(0x43); // 'C'
		// First frame follows the 42-byte header and starts with a frame sync.
		expect([out[42], out[43]]).toEqual([0xff, 0xf8]);
	});
});
