import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backfillAlbumCovers } from './coverart';

const JPEG = Buffer.from([
	0xff,
	0xd8,
	0xff,
	0xe0,
	0x00,
	0x10,
	0x4a,
	0x46,
	0x00,
	0x01,
	...new Array<number>(2000).fill(0x41),
]);

function mockFetch() {
	vi.stubGlobal(
		'fetch',
		vi.fn((url: unknown) => {
			const u = String(url);
			if (u.includes('/search/album')) {
				return Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({ data: [{ cover_xl: 'https://cdn.example/cover.jpg' }] }),
				});
			}
			return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(JPEG) });
		}),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('backfillAlbumCovers', () => {
	it('writes a canonical cover.jpg when the album folder has no art', async () => {
		mockFetch();
		const root = await mkdtemp(join(tmpdir(), 'navi-cover-'));
		const dir = join(root, 'Artist', 'Album');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, '01 - Song.flac'), 'x');
		const report = await backfillAlbumCovers([
			{ filePath: join(dir, '01 - Song.flac'), artist: 'Artist', album: 'Album' },
		]);
		expect(report).toEqual({ checked: 1, backfilled: 1 });
		await expect(stat(join(dir, 'cover.jpg'))).resolves.toBeDefined();
	});

	it('treats deduped variants as missing and writes canonical cover.jpg', async () => {
		mockFetch();
		const root = await mkdtemp(join(tmpdir(), 'navi-cover2-'));
		const dir = join(root, 'Artist', 'Album');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, '01 - Song.flac'), 'x');
		await writeFile(join(dir, 'cover (2).jpg'), 'junk');
		const report = await backfillAlbumCovers([
			{ filePath: join(dir, '01 - Song.flac'), artist: 'Artist', album: 'Album' },
		]);
		expect(report.backfilled).toBe(1);
		await expect(stat(join(dir, 'cover.jpg'))).resolves.toBeDefined();
	});

	it('skips folders that already have recognized art', async () => {
		mockFetch();
		const root = await mkdtemp(join(tmpdir(), 'navi-cover3-'));
		const dir = join(root, 'Artist', 'Album');
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, '01 - Song.flac'), 'x');
		await writeFile(join(dir, 'folder.jpg'), 'existing');
		const report = await backfillAlbumCovers([
			{ filePath: join(dir, '01 - Song.flac'), artist: 'Artist', album: 'Album' },
		]);
		expect(report).toEqual({ checked: 1, backfilled: 0 });
	});
});
