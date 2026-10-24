import type { LyricsQuery, LyricsResult, LyricsSource } from './types';
import { fetchWithRetry } from './http';

/**
 * lrc.red — Apple-Music-derived lyrics, looked up by ISRC.
 *
 * This is the most accurate source we have: the lookup key is the recording's
 * ISRC, not a fuzzy title search, so there is no "same title, different song"
 * failure mode. It is also the fastest (60 ms average over 157 measured calls)
 * and it returns TTML whose paragraphs carry `begin` times — and, for some
 * tracks, word-level spans.
 *
 * The catch, measured on the same library: some entries are unsynced
 * (`<p>` with no `begin`). Those are worth nothing to Navidrome, which drops
 * every lyric entry without timing, so this source returns null for them and
 * lets a real synced source answer instead.
 */

const BASE = 'https://lrc.red';
const UA = 'NaviSync/0.1.0 (self-hosted Navidrome companion)';
/** lrc.red's own duration is accurate to the millisecond; allow for DB rounding. */
const MAX_DURATION_DRIFT_SEC = 15;

interface LrcRedSong {
	source?: string;
	level?: string;
	duration?: number;
	title?: string;
	artist?: string;
	byModel?: boolean;
}

function decodeEntities(input: string): string {
	return input
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

/** TTML start times come in four shapes: `6.009`, `MM:SS.mmm`, `H:MM:SS.mmm`, `H:MM:SS:ff`. */
export function parseTtmlTime(raw: string): number | null {
	const value = raw.trim().replace(',', '.');
	if (!value) return null;

	if (/^[\d.]+s$/i.test(value)) {
		const seconds = Number.parseFloat(value);
		return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
	}
	if (/^[\d.]+$/.test(value)) {
		const seconds = Number.parseFloat(value);
		return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
	}

	const parts = value.split(':');
	const nums = parts.map((p) => Number.parseFloat(p));
	if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
	if (parts.length === 2) return nums[0] * 60 + nums[1];
	if (parts.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
	if (parts.length === 4) return nums[0] * 3600 + nums[1] * 60 + nums[2] + nums[3] / 30;
	return null;
}

function formatStamp(seconds: number): string {
	const cs = Math.max(0, Math.round(seconds * 100));
	const minutes = Math.floor(cs / 6000);
	const secs = Math.floor((cs % 6000) / 100);
	const hundredths = cs % 100;
	return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}

/**
 * Flattens TTML paragraphs into line-level LRC.
 *
 * Only timed paragraphs count. Tags are removed without inserting a space:
 * word-level TTML puts the spaces between the `<span>` elements as text nodes,
 * and inserting extra spaces would break CJK lines.
 */
export function ttmlToLrc(ttml: string): string | null {
	const lines: string[] = [];
	for (const match of ttml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
		const attrs = match[1];
		const begin = /\bbegin="([^"]+)"/i.exec(attrs);
		if (!begin) continue;
		const seconds = parseTtmlTime(begin[1]);
		if (seconds === null) continue;
		const text = decodeEntities(match[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''))
			.replace(/\s+/g, ' ')
			.trim();
		if (!text) continue;
		lines.push(`[${formatStamp(seconds)}] ${text}`);
	}
	return lines.length >= 2 ? lines.join('\n') : null;
}

export const lrcRedSource: LyricsSource = {
	id: 'lrc-red',
	displayName: 'lrc.red (ISRC)',

	async fetch(q: LyricsQuery): Promise<LyricsResult | null> {
		if (!q.isrc) return null;
		const res = await fetchWithRetry(
			`${BASE}/s/${encodeURIComponent(q.isrc)}.song.json`,
			{ headers: { 'User-Agent': UA, Accept: 'application/json' } },
			{ timeoutMs: 8000, retries: 2 },
		);
		if (!res?.ok) return null;

		const song = (await res.json()) as LrcRedSong;
		if (typeof song.duration === 'number' && q.durationSec) {
			if (Math.abs(song.duration - q.durationSec) > MAX_DURATION_DRIFT_SEC) return null;
		}
		const synced = ttmlToLrc(song.source ?? '');
		if (!synced) return null;
		// byModel means the text was transcribed from the audio. Keep it (it is
		// better than nothing) but flag it so an official synced copy can win.
		return { synced, plain: null, generated: song.byModel === true };
	},
};
