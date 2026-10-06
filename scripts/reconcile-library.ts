/**
 * Library reconcile CLI — the only destructive half of the dedupe.
 *
 * All decisions come from `planLibraryReconcile`, which is pure and unit-tested.
 * This file gathers the inventory, runs the planner, and applies the plan in TWO
 * PHASES with verification between them:
 *
 *   1. ADOPT  — insert a row for every unindexed file, and repoint rows at
 *               survivors. Verify each landed.
 *   2. DELETE — only then remove duplicate files, and repoint any row that pointed
 *               at one.
 *
 * The order is the invariant: no recording ever exists only as an orphan on disk.
 * If phase 1 fails, nothing is deleted.
 *
 * Dry run by default. `--apply` is required for any mutation.
 *
 * Usage (from the host that has the library mounted):
 *   bun scripts/reconcile-library.ts --root /mnt/hdd/music --db-url <url>
 *   bun scripts/reconcile-library.ts --root /mnt/hdd/music --db-url <url> --apply
 *   ... --cross-folder      treat same-title files in different albums as duplicates
 */
import { createHash } from 'node:crypto';
import { open, readdir, rm, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { Client } from 'pg';
import {
	describePlan,
	planLibraryReconcile,
	splitTrackFilename,
} from '../src/lib/server/library/reconcile';
import type { LibraryFile, LibraryRow } from '../src/lib/server/library/reconcile';

const args = process.argv.slice(2);
const flag = (n: string): boolean => args.includes(`--${n}`);
const opt = (n: string): string | null => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

const ROOT = opt('root');
const DB_URL = opt('db-url');
/**
 * The path PREFIX the application stores, which is NOT the prefix this script
 * scans with. The library host has it at /mnt/hdd/music; the app container mounts
 * the same volume at /music. Writing ROOT into the database reproduced the exact
 * failure that made covers and playback break for malevil: every stored path was
 * unopenable by the only process that reads it.
 */
const APP_PREFIX = opt('app-prefix') ?? '/music';
const APPLY = flag('apply');
const CROSS_FOLDER = flag('cross-folder');
const AUDIO = /\.(flac|mp3|wav|aiff|aif|m4a|ogg|opus)$/i;

if (!ROOT) {
	console.error('Usage: --root <library dir> [--db-url <url>] [--apply] [--cross-folder]');
	process.exit(2);
}
if (APPLY && !DB_URL) {
	console.error('--apply requires --db-url: adoption and repointing must be verified first.');
	process.exit(2);
}

interface Probe {
	bitDepth: number | null;
	sampleRateHz: number | null;
	durationSec: number | null;
}

/** FLAC STREAMINFO. The block header sits at offset 4, right after "fLaC". */
async function probeFlac(path: string): Promise<Probe> {
	const empty: Probe = { bitDepth: null, sampleRateHz: null, durationSec: null };
	const handle = await open(path, 'r');
	try {
		const head = Buffer.alloc(42);
		await handle.read(head, 0, 42, 0);
		if (head.subarray(0, 4).toString('latin1') !== 'fLaC') return empty;
		let p = 4;
		while (p + 4 <= head.length) {
			const type = head[p] & 0x7f;
			const len = ((head[p + 1] & 0x7f) << 16) | (head[p + 2] << 8) | head[p + 3];
			if (type === 0) {
				const b = head.subarray(p + 4, p + 4 + 18);
				if (b.length < 14) return empty;
				const sampleRateHz = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
				const bitDepth = (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1;
				const total =
					((b[13] & 0x0f) * 4294967296 +
						b[14] * 16777216 +
						b[15] * 65536 +
						b[16] * 256 +
						b[17]) >>>
					0;
				return {
					bitDepth: bitDepth || null,
					sampleRateHz: sampleRateHz || null,
					durationSec: sampleRateHz > 0 ? Math.round(total / sampleRateHz) : null,
				};
			}
			p += 4 + len;
			if ((head[p - 4 - len] & 0x80) !== 0) break;
		}
		return empty;
	} finally {
		await handle.close();
	}
}

async function probeWav(path: string): Promise<Probe> {
	const empty: Probe = { bitDepth: null, sampleRateHz: null, durationSec: null };
	try {
		const handle = await open(path, 'r');
		try {
			const head = Buffer.alloc(64);
			await handle.read(head, 0, 64, 0);
			const i = head.toString('latin1').indexOf('fmt ');
			if (i < 0 || i + 24 > head.length) return empty;
			return {
				bitDepth: head.readUInt16LE(i + 14) || null,
				sampleRateHz: head.readUInt32LE(i + 4) || null,
				durationSec: null,
			};
		} finally {
			await handle.close();
		}
	} catch {
		return empty;
	}
}

async function sha256(path: string): Promise<string> {
	const h = createHash('sha256');
	const buf = Buffer.alloc(1 << 20);
	const handle = await open(path, 'r');
	try {
		for (;;) {
			const { bytesRead } = await handle.read(buf, 0, buf.length, null);
			if (bytesRead === 0) break;
			h.update(buf.subarray(0, bytesRead));
		}
	} finally {
		await handle.close();
	}
	return h.digest('hex');
}

async function walk(dir: string, out: string[]): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) await walk(full, out);
		else out.push(full);
	}
}

async function main(): Promise<void> {
	// ── inventory ─────────────────────────────────────────────────────────
	const all: string[] = [];
	await walk(ROOT, all);
	const audio = all.filter((f) => AUDIO.test(f));
	console.log(`scanned ${all.length} files, ${audio.length} audio, under ${ROOT}`);

	const files: LibraryFile[] = [];
	for (const abs of audio) {
		const ext = extname(abs).toLowerCase();
		const probe =
			ext === '.flac'
				? await probeFlac(abs)
				: await probeWav(abs).catch(() => ({
						bitDepth: null,
						sampleRateHz: null,
						durationSec: null,
					}));
		files.push({
			relPath: relative(ROOT, abs).split(sep).join('/'),
			sizeBytes: (await stat(abs)).size,
			bitDepth: probe.bitDepth,
			sampleRateHz: probe.sampleRateHz,
			sha256: await sha256(abs),
		});
	}

	// ── index state ───────────────────────────────────────────────────────
	let rows: LibraryRow[] = [];
	if (DB_URL) {
		const client = new Client({ connectionString: DB_URL });
		await client.connect();
		const { rows: raw } = await client.query(
			`select id, file_path, title, artist, album from tracks where file_path is not null`,
		);
		rows = raw.map((r) => {
			const filePath = String(r.file_path);
			// Strip the library prefix so stored and on-disk paths agree. Getting this
			// wrong once wrote 695 rows the app could not open.
			let rel = filePath;
			for (const prefix of [`${ROOT}/`, '/mnt/hdd/music/', '/music/']) {
				if (rel.startsWith(prefix)) {
					rel = rel.slice(prefix.length);
					break;
				}
			}
			return {
				id: String(r.id),
				filePath,
				relPath: rel,
				title: String(r.title ?? ''),
				artist: String(r.artist ?? ''),
				album: r.album == null ? null : String(r.album),
			};
		});
		await client.end();
		console.log(`index: ${rows.length} filed row(s)`);
	}

	const plan = planLibraryReconcile(files, rows, { crossFolderMatching: CROSS_FOLDER });
	console.log('\nPLAN');
	console.log(describePlan(plan));

	if (!APPLY) {
		console.log('\nDry run. Re-run with --apply to adopt, repoint and delete.');
		return;
	}

	// ── phase 1: adopt and repoint, verified ──────────────────────────────
	const client = new Client({ connectionString: DB_URL! });
	await client.connect();

	const adopted: LibraryFile[] = [];
	for (const a of plan.adopt) {
		const abs = join(ROOT, a.relPath);
		const sp = a.relPath.split('/');
		const ext = extname(a.relPath).toLowerCase().replace('.', '');
		const artist = sp.length >= 3 ? sp[sp.length - 3] : 'Unknown Artist';
		const album = sp.length >= 3 ? sp[sp.length - 2] : null;
		const { trackNumber } = splitTrackFilename(sp[sp.length - 1]);
		const probe =
			ext === 'flac'
				? await probeFlac(abs)
				: { bitDepth: null, sampleRateHz: null, durationSec: null };
		const dir = join(ROOT, ...sp.slice(0, -1));
		let coverPath: string | null = null;
		for (const c of ['cover.jpg', 'cover.png', 'folder.jpg', 'cover.jpeg']) {
			const cp = join(dir, c);
			if (
				await stat(cp).then(
					() => true,
					() => false,
				)
			) {
				coverPath = cp;
				break;
			}
		}
		await client.query(
			`insert into tracks (provider, provider_track_id, title, artist, album, album_artist,
			   track_number, duration_sec, format, bit_depth, sample_rate_hz, is_lossless,
			   size_bytes, checksum_sha256, file_path, cover_path, lyrics_status, download_status)
			 values ('local', $1, $2, $3, $4, $3, $5, $6, $7, $8, $9, true, $10, $11, $12, $13, 'none', 'completed')`,
			[
				`local:${a.sha256.slice(0, 32)}`,
				splitTrackFilename(sp[sp.length - 1]).title,
				artist,
				album,
				trackNumber,
				probe.durationSec,
				ext,
				a.bitDepth,
				a.sampleRateHz,
				a.sizeBytes,
				a.sha256,
				`${APP_PREFIX}/${a.relPath}`,
				coverPath
					? `${APP_PREFIX}/${a.relPath.split('/').slice(0, -1).join('/')}/${coverPath.split('/').pop()}`
					: null,
			],
		);
		adopted.push(a);
	}
	console.log(`\nphase 1: adopted ${adopted.length} row(s)`);

	for (const rp of plan.repoint) {
		const to = join(ROOT, rp.toRelPath);
		const stored = `${APP_PREFIX}/${rp.toRelPath}`;
		if (
			!(await stat(to).then(
				() => true,
				() => false,
			))
		) {
			console.error(`  REFUSING: repoint target missing on disk: ${to}`);
			await client.end();
			process.exit(4);
		}
		await client.query('update tracks set file_path = $2 where id = $1', [rp.rowId, stored]);
	}
	console.log(`phase 1: repointed ${plan.repoint.length} row(s)`);

	// Verify the survivors really are indexed now. If this fails, delete nothing.
	for (const d of plan.delete) {
		const { rows: checkRows } = await client.query(
			'select count(*)::int as n from tracks where file_path = $1',
			[`${APP_PREFIX}/${d.survivor.relPath}`],
		);
		if (Number(checkRows[0]?.n ?? 0) === 0) {
			console.error(
				`  ABORT: survivor ${d.survivor.relPath} is still not indexed; deleting nothing.`,
			);
			await client.end();
			process.exit(5);
		}
	}
	console.log('phase 1: every survivor is indexed.');

	// ── phase 2: delete ───────────────────────────────────────────────────
	let deleted = 0;
	let freed = 0;
	for (const d of plan.delete) {
		try {
			freed += d.file.sizeBytes;
			await rm(join(ROOT, d.file.relPath), { force: true });
			deleted++;
		} catch (err) {
			console.error(`  FAILED ${d.file.relPath}: ${String(err)}`);
		}
	}
	console.log(
		`\nphase 2: deleted ${deleted} duplicate(s), ${(freed / 1048576).toFixed(1)} MiB reclaimed`,
	);
	await client.end();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
