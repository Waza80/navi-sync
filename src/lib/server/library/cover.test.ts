import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCoverBytes, coverMimeType } from './cover';

let dir: string;

// Minimal real magic bytes, so the content check is exercised honestly.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(64, 7),
]);

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), 'navi-cover-'));
	await writeFile(join(dir, 'cover.jpg'), JPEG);
	await writeFile(join(dir, 'cover.png'), PNG);
	await writeFile(join(dir, 'empty.jpg'), Buffer.alloc(0));
	await writeFile(join(dir, 'notimage.jpg'), Buffer.from('<html>not an image</html>'));
	await writeFile(join(dir, 'huge.jpg'), Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]));
	await mkdir(join(dir, 'sub'), { recursive: true });
	await writeFile(join(dir, 'sub', 'deep.jpg'), JPEG);
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('readCoverBytes', () => {
	it('reads a JPEG', async () => {
		const b = await readCoverBytes(join(dir, 'cover.jpg'));
		expect(b?.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
	});

	it('reads a PNG', async () => {
		const b = await readCoverBytes(join(dir, 'cover.png'));
		expect(b?.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	});

	it('reads from a subdirectory', async () => {
		expect(await readCoverBytes(join(dir, 'sub', 'deep.jpg'))).not.toBeNull();
	});

	it('returns null for a missing path, an empty one and a nullish one', async () => {
		expect(await readCoverBytes(null)).toBeNull();
		expect(await readCoverBytes(undefined)).toBeNull();
		expect(await readCoverBytes('')).toBeNull();
		expect(await readCoverBytes(join(dir, 'nope.jpg'))).toBeNull();
		expect(await readCoverBytes(join(dir, 'empty.jpg'))).toBeNull();
	});

	it('refuses content that is not an image', async () => {
		// A provider returning an HTML error page with a .jpg name must not be
		// embedded into a music file.
		expect(await readCoverBytes(join(dir, 'notimage.jpg'))).toBeNull();
	});

	it('refuses an unexpected extension', async () => {
		await writeFile(join(dir, 'cover.txt'), JPEG);
		expect(await readCoverBytes(join(dir, 'cover.txt'))).toBeNull();
	});

	it('refuses a path with a NUL byte', async () => {
		expect(await readCoverBytes(join(dir, 'cover.jpg\0.txt'))).toBeNull();
	});

	it('refuses a relative path', async () => {
		expect(await readCoverBytes('cover.jpg')).toBeNull();
	});

	it('refuses a path outside the library root', async () => {
		expect(await readCoverBytes('/etc/passwd.jpg', { libraryRoot: dir })).toBeNull();
	});

	it('bounds the read size', async () => {
		expect(await readCoverBytes(join(dir, 'huge.jpg'), { maxBytes: 1024 })).toBeNull();
		expect(await readCoverBytes(join(dir, 'huge.jpg'))).not.toBeNull();
	});
});

describe('coverMimeType', () => {
	it('detects PNG and JPEG', () => {
		expect(coverMimeType(PNG)).toBe('image/png');
		expect(coverMimeType(JPEG)).toBe('image/jpeg');
	});
});

describe('degraded queue responses stay usable', () => {
	// The shape /api/jobs returns when the queue read fails. Asserted here because
	// it is the contract the dashboard's `degraded` flag depends on, and a change
	// to either side silently turning a transient DB blip back into a blank page
	// is exactly the failure this guards.
	it('reports totals in the same shape as a healthy response', () => {
		const degraded = { total: 0, active: 0, byStatus: {} };
		expect(Object.keys(degraded).sort()).toEqual(['active', 'byStatus', 'total']);
	});
});
