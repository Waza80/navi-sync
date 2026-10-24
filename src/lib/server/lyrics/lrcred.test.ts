import { describe, expect, it } from 'vitest';
import { parseTtmlTime, ttmlToLrc } from './lrcred';

describe('parseTtmlTime', () => {
	it('accepts every timestamp shape lrc.red emits', () => {
		expect(parseTtmlTime('6.009')).toBeCloseTo(6.009);
		expect(parseTtmlTime('0:10.481')).toBeCloseTo(10.481);
		expect(parseTtmlTime('00:01:05.123')).toBeCloseTo(65.123);
		expect(parseTtmlTime('1:02:03.500')).toBeCloseTo(3723.5);
		expect(parseTtmlTime('12.5s')).toBeCloseTo(12.5);
		expect(parseTtmlTime('1:02:03:15')).toBeCloseTo(3723.5);
	});

	it('rejects junk instead of producing NaN offsets', () => {
		expect(parseTtmlTime('')).toBeNull();
		expect(parseTtmlTime('soon')).toBeNull();
		expect(parseTtmlTime('-1')).toBeNull();
		expect(parseTtmlTime('1:2:3:4:5')).toBeNull();
	});
});

describe('ttmlToLrc (lrc.red → LRC)', () => {
	it('converts line-level paragraphs', () => {
		const ttml =
			'<p begin="00:00:01.090" end="00:00:04.890">Des doutes en boucle</p>' +
			'<p begin="00:00:04.890" end="00:00:09.170">J\'ai le cœur si lourd</p>';
		expect(ttmlToLrc(ttml)).toBe(
			"[00:01.09] Des doutes en boucle\n[00:04.89] J'ai le cœur si lourd",
		);
	});

	it('flattens word-level spans without gluing or splitting words', () => {
		const ttml =
			'<p begin="0:10.481"><span begin="0:10.481">J\'af</span><span begin="0:10.695">fronte</span> ' +
			'<span begin="0:10.918">le</span> <span begin="0:11.100">vide</span></p>' +
			'<p begin="0:12.000">Deuxième ligne</p>';
		expect(ttmlToLrc(ttml)).toBe("[00:10.48] J'affronte le vide\n[00:12.00] Deuxième ligne");
	});

	it('keeps CJK words glued (no artificial spaces between spans)', () => {
		const ttml =
			'<p begin="1.000"><span>少</span><span>年</span><span>の</span></p><p begin="2.000">日々</p>';
		expect(ttmlToLrc(ttml)).toBe('[00:01.00] 少年の\n[00:02.00] 日々');
	});

	it('decodes entities', () => {
		const ttml =
			'<p begin="1.000">Tom &amp; Jerry &quot;live&quot;</p><p begin="2.000">&#20320;&#22909;</p>';
		expect(ttmlToLrc(ttml)).toBe('[00:01.00] Tom & Jerry "live"\n[00:02.00] 你好');
	});

	it('returns null when the TTML has no timing (Navidrome would drop it)', () => {
		const ttml = "<p>Des doutes en boucle</p><p>J'ai le cœur si lourd</p>";
		expect(ttmlToLrc(ttml)).toBeNull();
	});

	it('returns null for fewer than two timed lines', () => {
		expect(ttmlToLrc('<p begin="1.000">only one</p>')).toBeNull();
	});

	it('skips untimed paragraphs inside a mostly timed document', () => {
		const ttml = '<p>no timing</p><p begin="1.000">one</p><p begin="2.000">two</p>';
		expect(ttmlToLrc(ttml)).toBe('[00:01.00] one\n[00:02.00] two');
	});
});
