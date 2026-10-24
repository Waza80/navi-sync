import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadLyrics } from './index';
import type { LyricsQuery, LyricsResult, LyricsSource } from './types';
import type { TrackMeta } from '$lib/server/providers/types';

function meta(over: Partial<TrackMeta> = {}): TrackMeta {
	return {
		provider: 'deezer',
		providerTrackId: '2330156105',
		title: 'Bahia',
		artist: 'Luidji',
		album: 'Bahia',
		albumArtist: 'Luidji',
		isrc: 'FR9W12320132',
		trackNumber: 1,
		discNumber: 1,
		durationSec: 172,
		year: 2023,
		genre: null,
		coverUrl: null,
		sourceUrl: null,
		streamToken: null,
		...over,
	};
}

function source(id: string, result: LyricsResult | null | Error): LyricsSource {
	return {
		id,
		displayName: id,
		fetch() {
			if (result instanceof Error) return Promise.reject(result);
			return Promise.resolve(result);
		},
	};
}

const dirs: string[] = [];
async function tempAudio(): Promise<{ dir: string; audio: string }> {
	const dir = await mkdtemp(join(tmpdir(), 'navisync-lyrics-'));
	dirs.push(dir);
	const audio = join(dir, '01 - Bahia.flac');
	await writeFile(audio, 'fake audio');
	return { dir, audio };
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('downloadLyrics source traversal', () => {
	it('keeps traversing after plain and prefers a later synced result', async () => {
		const { dir, audio } = await tempAudio();
		const result = await downloadLyrics(meta(), audio, [
			source('first-plain', { synced: null, plain: 'plain words' }),
			source('later-synced', { synced: '[00:21.27]bonjour', plain: null }),
		]);

		expect(result).toMatchObject({ success: true, synced: true, source: 'later-synced' });
		expect(await readFile(join(dir, '01 - Bahia.lrc'), 'utf8')).toContain('[00:21.27]bonjour');
		await expect(readFile(join(dir, '01 - Bahia.txt'), 'utf8')).rejects.toThrow();
	});

	it('writes the first plain result only after every source declined to sync', async () => {
		const { dir, audio } = await tempAudio();
		const result = await downloadLyrics(meta(), audio, [
			source('plain-a', { synced: null, plain: 'first words' }),
			source('plain-b', { synced: null, plain: 'second words' }),
			source('none', null),
		]);

		expect(result).toMatchObject({ success: true, synced: false, source: 'plain-a' });
		expect(await readFile(join(dir, '01 - Bahia.txt'), 'utf8')).toBe('first words\n');
	});

	it('never downgrades an existing synced sidecar to a plain fetch', async () => {
		const { dir, audio } = await tempAudio();
		await writeFile(join(dir, '01 - Bahia.lrc'), '[00:01.00]timed lyric\n', 'utf8');

		const result = await downloadLyrics(meta(), audio, [
			source('plain-only', { synced: null, plain: 'plain words' }),
		]);

		expect(result).toMatchObject({ success: true, synced: true });
		expect(result.path).toMatch(/\.lrc$/);
		expect(await readFile(join(dir, '01 - Bahia.lrc'), 'utf8')).toBe('[00:01.00]timed lyric\n');
	});

	it('reports a definitive instrumental instead of a retryable failure', async () => {
		const { audio } = await tempAudio();
		const result = await downloadLyrics(meta(), audio, [
			source('lrclib', { synced: null, plain: null, instrumental: true }),
			source('apple', null),
		]);

		expect(result).toMatchObject({ success: false, instrumental: true });
	});

	it('lets an official synced copy beat a machine-generated one', async () => {
		const { dir, audio } = await tempAudio();
		const result = await downloadLyrics(meta(), audio, [
			source('lrc-red', { synced: '[00:01.00]asr words', plain: null, generated: true }),
			source('deezer', { synced: '[00:01.00]official words', plain: null }),
		]);

		expect(result).toMatchObject({ success: true, synced: true, source: 'deezer' });
		expect(await readFile(join(dir, '01 - Bahia.lrc'), 'utf8')).toContain('official words');
	});

	it('uses machine-generated synced lyrics when no official synced source exists', async () => {
		const { dir, audio } = await tempAudio();
		const result = await downloadLyrics(meta(), audio, [
			source('lrc-red', { synced: '[00:01.00]asr words', plain: null, generated: true }),
			source('plain', { synced: null, plain: 'plain words' }),
		]);

		expect(result).toMatchObject({
			success: true,
			synced: true,
			generated: true,
			source: 'lrc-red',
		});
		expect(await readFile(join(dir, '01 - Bahia.lrc'), 'utf8')).toContain('asr words');
		await expect(readFile(join(dir, '01 - Bahia.txt'), 'utf8')).rejects.toThrow();
	});

	it('survives a throwing source and keeps looking', async () => {
		const { audio } = await tempAudio();
		const result = await downloadLyrics(meta(), audio, [
			source('boom', new Error('backend exploded')),
			source('works', { synced: '[00:02.00]ok', plain: null }),
		]);

		expect(result).toMatchObject({ success: true, synced: true, source: 'works' });
	});

	it('passes the ISRC but only passes a track id for Deezer rows', async () => {
		const seen: LyricsQuery[] = [];
		const capture: LyricsSource = {
			id: 'capture',
			displayName: 'capture',
			fetch(q) {
				seen.push(q);
				return Promise.resolve(null);
			},
		};
		const { audio } = await tempAudio();

		await downloadLyrics(meta({ provider: 'local' }), audio, [capture]);
		await downloadLyrics(meta({ provider: 'deezer' }), audio, [capture]);

		expect(seen[0]).toMatchObject({ isrc: 'FR9W12320132', providerTrackId: null });
		expect(seen[1]).toMatchObject({ isrc: 'FR9W12320132', providerTrackId: '2330156105' });
	});
});
