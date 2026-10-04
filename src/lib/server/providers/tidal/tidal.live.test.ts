/**
 * Live integration check for the Tidal provider against a real hiFi instance.
 *
 * Skipped unless TIDAL_TEST_INSTANCE is set, so `bun test` stays hermetic:
 *   TIDAL_TEST_INSTANCE=https://hifi.orbitsc.net bunx vitest run tidal.live
 *
 * These assert the things that only a live server can prove: that the instance's
 * response shapes still match the client, that a manifest really yields ~90
 * segments, and that the demuxed file decodes to the catalog's duration.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { TidalClient } from './client';
import { downloadTidalFlac } from './download';

const exec = promisify(execFile);
const INSTANCE = process.env.TIDAL_TEST_INSTANCE;

describe.skipIf(!INSTANCE)('tidal provider (live instance)', () => {
	const client = new TidalClient({ instanceUrl: INSTANCE as string });

	it('searches the catalogue', async () => {
		const results = await client.search('Daft Punk Get Lucky');
		expect(results.length).toBeGreaterThan(0);
		const hit = results.find((t) => t.title.startsWith('Get Lucky'));
		expect(hit).toBeDefined();
		expect(hit?.id).toMatch(/^\d+$/);
		expect(hit?.isrc).toBeTruthy();
	});

	it('reads bare-id metadata with album + cover', async () => {
		const [first] = await client.search('Daft Punk Get Lucky');
		const track = await client.track((first as { id: string }).id);
		expect(track.title).toBeTruthy();
		expect(track.album).toBeTruthy();
		expect(track.albumId).toBeTruthy();
		expect(track.artworkUrl).toMatch(/^https:\/\/resources\.tidal\.com\/images\//);
		// The album cover URL must not contain dashes in the slug path.
		expect(track.artworkUrl).not.toMatch(/images\/[0-9a-f]{8}-/);
	});

	it('lists an album tracklist', async () => {
		const [first] = await client.search('Daft Punk Random Access Memories');
		const albumId = first?.albumId ?? '';
		const tracks = await client.albumTracks(albumId);
		expect(tracks.length).toBeGreaterThan(1);
		for (const t of tracks) expect(t.albumId).toBe(albumId);
	});

	it('resolves a manifest with many segments', async () => {
		const [first] = await client.search('Daft Punk Get Lucky');
		const plan = await client.streamPlan((first as { id: string }).id);
		expect(plan.manifest.segmentCount).toBeGreaterThan(20);
		expect(plan.manifest.initUrl).toMatch(/^https:/);
		expect(plan.manifest.segmentUrl(1)).not.toContain('$Number$');
		expect(plan.manifest.segmentUrl(1)).not.toBe(plan.manifest.segmentUrl(2));
		expect(plan.bitDepth).toBe(16);
	});

	it('downloads and demuxes a full-length track to a decodable FLAC', async () => {
		const [first] = await client.search('Daft Punk Get Lucky');
		const res = await client.resolve((first as { id: string }).id, {
			preferLossless: true,
			minBitrateKbps: 320,
			allowLowerFallback: true,
		});
		const dir = await mkdtemp(join(tmpdir(), 'navi-tidal-live-'));
		const dest = join(dir, 'out.flac');
		try {
			const plan = res.segments;
			expect(plan).toBeDefined();
			const out = await downloadTidalFlac(plan ?? { initUrl: '', mediaUrls: [] }, dest, {
				concurrency: 8,
			});
			// Full-length, not a preview: Get Lucky is ~6m10s.
			expect(out.streamInfo.durationSec).toBeGreaterThan(300);
			expect(out.streamInfo.durationSec).toBeLessThan(400);
			expect(out.streamInfo.sampleRateHz).toBe(44100);
			expect(out.streamInfo.bitDepth).toBe(16);
			expect(out.streamInfo.channels).toBe(2);

			const buf = new Uint8Array(await readFile(dest));
			expect(String.fromCharCode(...buf.subarray(0, 4))).toBe('fLaC');

			// The `flac` CLI is what the production image actually ships. It exits
			// non-zero on any bad frame, so the exit code is the real assertion;
			// its banner carries no "Verify" wording in flac 1.5.
			await exec('flac', ['-t', dest]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 180_000);
});
