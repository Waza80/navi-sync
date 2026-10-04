import { describe, expect, it } from 'vitest';
import { parseMonochromeInput } from './parse';

describe('parseMonochromeInput', () => {
	it('parses instance track links', () => {
		expect(parseMonochromeInput('https://mono.example.com/track/254833237')).toEqual({
			kind: 'track',
			id: '254833237',
		});
	});
	it('parses album/playlist/artist kinds (batch later)', () => {
		expect(parseMonochromeInput('https://mono.example.com/album/123')?.kind).toBe('album');
		expect(parseMonochromeInput('https://mono.example.com/playlist/abc')?.kind).toBe(
			'playlist',
		);
		expect(parseMonochromeInput('https://mono.example.com/artist/9')?.kind).toBe('artist');
	});
	it('accepts bare ids and rejects garbage', () => {
		expect(parseMonochromeInput('254833237')?.id).toBe('254833237');
		expect(parseMonochromeInput('not a link')).toBeNull();
		expect(parseMonochromeInput('https://example.com/other/1')).toBeNull();
	});
});
