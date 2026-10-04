import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lyricsSidecar } from './index';

const meta = {
	provider: 'deezer',
	providerTrackId: '1',
	title: 'Song',
	artist: 'Artist',
	album: 'Album',
	albumArtist: 'Artist',
	isrc: null,
	trackNumber: 1,
	discNumber: null,
	durationSec: null,
	year: null,
	genre: null,
	coverUrl: null,
	sourceUrl: null,
	streamToken: null,
};

describe('lyricsSidecar (fetch gating)', () => {
	it('returns null when the song misses lyrics', async () => {
		const root = await mkdtemp(join(tmpdir(), 'navi-nolyrics-'));
		expect(await lyricsSidecar(meta, root)).toBeNull();
	});
	it('finds a synced sidecar without touching the APIs', async () => {
		const root = await mkdtemp(join(tmpdir(), 'navi-synced-'));
		await mkdir(join(root, 'Artist', 'Album'), { recursive: true });
		await writeFile(join(root, 'Artist', 'Album', '01 - Song.lrc'), '[00:01.00]hi\n');
		const found = await lyricsSidecar(meta, root);
		expect(found?.kind).toBe('synced');
		expect(found?.path.endsWith('.lrc')).toBe(true);
	});
	it('finds a plain sidecar when no synced one exists', async () => {
		const root = await mkdtemp(join(tmpdir(), 'navi-plain-'));
		await mkdir(join(root, 'Artist', 'Album'), { recursive: true });
		await writeFile(join(root, 'Artist', 'Album', '01 - Song.txt'), 'hi\n');
		const found = await lyricsSidecar(meta, root);
		expect(found?.kind).toBe('plain');
	});
});
