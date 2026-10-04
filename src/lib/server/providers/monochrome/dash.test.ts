import { describe, expect, it } from 'vitest';
import {
	parseDashManifest,
	generateDashSegmentUrls,
	getManifestFormatsForQuality,
	inferDashExtension,
} from './dash';

const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="9" bandwidth="345000" codecs="flac" audioSamplingRate="44100">
        <BaseURL>https://cdn.example/audio/9/</BaseURL>
        <SegmentTemplate timescale="44100" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%05d$.m4s" startNumber="1">
          <SegmentTimeline>
            <S t="0" d="43008" r="1" />
            <S d="21504" />
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

describe('parseDashManifest', () => {
	const m = parseDashManifest(FIXTURE, 'https://cdn.example/track/123/manifest.mpd');
	it('selects the highest-bandwidth audio representation', () => {
		expect(m.repId).toBe('9');
		expect(m.codecs).toBe('flac');
		expect(m.baseUrl).toBe('https://cdn.example/audio/9/');
	});
	it('expands the SegmentTimeline (S r=1 repeats)', () => {
		expect(m.segments).toEqual([
			{ number: 1, time: 0 },
			{ number: 2, time: 43008 },
			{ number: 3, time: 86016 },
		]);
	});
	it('builds zero-padded segment URLs (init first)', () => {
		const urls = generateDashSegmentUrls(m);
		expect(urls[0]).toBe('https://cdn.example/audio/9/9/init.mp4');
		expect(urls[1]).toBe('https://cdn.example/audio/9/9/seg-00001.m4s');
		expect(urls[3]).toBe('https://cdn.example/audio/9/9/seg-00003.m4s');
		expect(urls).toHaveLength(4);
	});
	it('rejects non-DASH payloads', () => {
		expect(() => parseDashManifest('<html></html>')).toThrow('Invalid DASH manifest');
	});
});

describe('quality formats', () => {
	it('maps quality tokens to ordered format lists', () => {
		expect(getManifestFormatsForQuality('HI_RES_LOSSLESS')[0]).toBe('FLAC_HIRES');
		expect(getManifestFormatsForQuality('lossless')).toEqual(['FLAC', 'AACLC', 'HEAACV1']);
		expect(getManifestFormatsForQuality('low')).toEqual(['HEAACV1', 'AACLC']);
	});
});

describe('inferDashExtension', () => {
	it('accepts flac, rejects aac for now', () => {
		expect(inferDashExtension('audio/mp4', 'flac')).toBe('flac');
		expect(inferDashExtension('audio/mp4', 'mp4a.40.2')).toBeNull();
	});
});
