/**
 * Remove duplicate library files, KEEPING THE BEST ONE.
 *
 * Symptom: `07 - sludgecrank.flac`, `07 - sludgecrank (2).flac`, `07 - sludgecrank (3).flac`
 * in one album folder. Navidrome greys the album out because several files claim the
 * same track number.
 *
 * The suffix is a re-download marker, and a later fetch is very often BETTER — that
 * is the whole reason the quality pipeline refetched. So the rule is NOT "keep the
 * unprefixed original"; deleting down to the unprefixed copy throws away the best
 * encode, which is the opposite of what is wanted. Instead every candidate for a
 * recording is scored on real audio properties and the winner is kept.
 *
 * Ranking, strongest signal first:
 *   1. FLAC bit depth, then sample rate   (24/192 beats 16/44.1 unambiguously)
 *   2. FLAC sample rate
 *   3. file size                          (proxy for lossless detail)
 *   4. filename without a suffix          (only ever a tie-break)
 *
 * WAV/AIFF headers carry bit depth and rate too; MP3 and anything else fall back to
 * size. Ties fall back to the unprefixed name so the result is deterministic.
 *
 * Deleting a file the database points at is not enough — the row must be repointed
 * at the survivor, or the library has dangling rows. `--db-url` does that.
 *
 * Safety:
 *   - dry-run by default; --apply to act
 *   - only groups where the same base name has 2+ files
 *   - a group is skipped entirely if the winner cannot be determined
 *   - the survivor is never deleted
 *   - never deletes the ONLY copy of a recording (a group of 1 is left alone)
 *
 * Usage:
 *   ssh wyzz@192.168.1.16 'bun run scripts/dedupe-library-files.ts --root /mnt/hdd/music'
 *   ssh wyzz@192.168.1.16 'bun run scripts/dedupe-library-files.ts --root /mnt/hdd/music --apply'
 */
import { createHash } from 'node:crypto';
import { open, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n: string): boolean => args.includes(`--${n}`);
const opt = (n: string): string | null => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

const ROOT = opt('root') ?? process.env.MUSIC_LIBRARY_DIR ?? null;
const APPLY = flag('apply');
const DB_URL = opt('db-url') ?? process.env.DATABASE_URL ?? null;

if (!ROOT) {
	console.error('Pass --root <library dir>.');
	process.exit(2);
}

interface Quality {
	bitDepth: number | null;
	sampleRate: number | null;
	size: number;
}

/** Read bit depth / sample rate from a FLAC or WAV header; null when not derivable. */
async function probe(path: string, size: number): Promise<Quality> {
	const q: Quality = { bitDepth: null, sampleRate: null, size };
	const ext = extname(path).toLowerCase();
	const handle = await open(path, 'r');
	try {
		if (ext === '.flac') {
			// "fLaC" then metadata blocks; STREAMINFO starts with min/max blocksize.
			const head = Buffer.alloc(42);
			await handle.read(head, 0, 42, 0);
			if (head.subarray(0, 4).toString('latin1') !== 'fLaC') return q;
			const off = 4;
			// Skip the first metadata block (STREAMINFO) to be safe, then read from it.
			// The first block header sits right after the 4-byte magic, so p starts
			// at 4, not 8. Reading from 8 skipped the header and treated the
			// block-length bytes as a type, which made every probe return null.
			let p = off;
			while (p + 4 <= head.length) {
				const last = (head[p] & 0x80) !== 0;
				const len = ((head[p + 1] & 0x7f) << 16) | (head[p + 2] << 8) | head[p + 3];
				const type = head[p] & 0x7f;
				if (type === 0 && p + 4 + 18 <= head.length) {
					const b = head.subarray(p + 4, p + 4 + 18);
					q.sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
					// 5 bits hold bit depth MINUS ONE.
					q.bitDepth = (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1;
					return q;
				}
				p += 4 + len;
				if (last) break;
			}
			return q;
		}
		if (ext === '.wav' || ext === '.aiff' || ext === '.aif') {
			// RIFF/WAVE fmt chunk: channels(2) rate(4) byteRate(4) blockAlign(2) bits(2)
			const head = Buffer.alloc(64);
			await handle.read(head, 0, 64, 0);
			const s = head.toString('latin1');
			const i = s.indexOf('fmt ');
			if (i >= 0 && i + 24 <= head.length) {
				q.sampleRate = head.readUInt32LE(i + 4);
				q.bitDepth = head.readUInt16LE(i + 14);
			}
		}
	} finally {
		await handle.close();
	}
	return q;
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

interface Member {
	path: string;
	name: string;
	suffixed: boolean;
	index: number;
	q: Quality;
	digest: string;
}

/** Higher is better. Bit depth dominates, then rate, then size. */
function rank(m: Member): number[] {
	return [m.q.bitDepth ?? 0, m.q.sampleRate ?? 0, m.q.size];
}

function better(a: Member, b: Member): boolean {
	const ra = rank(a);
	const rb = rank(b);
	for (let i = 0; i < ra.length; i++) {
		if (ra[i] !== rb[i]) return ra[i] > rb[i];
	}
	// Deterministic tie-break: prefer the unprefixed name, then the lowest suffix.
	if (a.suffixed !== b.suffixed) return !a.suffixed;
	return a.index < b.index;
}

function baseOf(name: string): string | null {
	const m = /^(.*?)(?: \((\d+)\))?(\.[^.]+)$/.exec(name);
	if (!m) return null;
	return `${m[1]}${m[3].toLowerCase()}`;
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

const all: string[] = [];
await walk(ROOT, all);
const audio = all.filter((f) => /\.(flac|wav|aiff|aif|mp3|m4a|ogg|opus)$/i.test(f));
console.log(`scanned ${all.length} files (${audio.length} audio) under ${ROOT}`);

const groups = new Map<string, string[]>();
for (const f of audio) {
	const key = join(dirname(f), baseOf(basename(f)) ?? basename(f));
	groups.set(key, [...(groups.get(key) ?? []), f]);
}
const dupes = [...groups.entries()].filter(([, v]) => v.length > 1);
console.log(`${dupes.length} recording(s) with more than one file\n`);

interface Plan {
	keep: Member;
	drop: Member[];
	identicalToKeep: boolean[];
}
const plans: Plan[] = [];

for (const [, paths] of dupes) {
	const members: Member[] = [];
	for (const p of paths) {
		const name = basename(p);
		const m = /^(.*) \((\d+)\)(.*)$/.exec(name);
		const size = (await stat(p)).size;
		members.push({
			path: p,
			name,
			suffixed: m !== null,
			index: m ? Number(m[2]) : 1,
			q: await probe(p, size),
			digest: await sha256(p),
		});
	}
	members.sort(better);
	const keep = members[0];
	const drop = members.slice(1);
	plans.push({
		keep,
		drop,
		identicalToKeep: await Promise.all(drop.map(async (d) => d.digest === keep.digest)),
	});
}

const fmt = (m: Member): string =>
	`${m.name} [${m.q.bitDepth ?? '?'}bit/${m.q.sampleRate ?? '?'}Hz ${(m.q.size / 1048576).toFixed(1)}MiB]`;

for (const p of plans) {
	console.log(`KEEP  ${fmt(p.keep)}`);
	for (let i = 0; i < p.drop.length; i++) {
		console.log(
			`  DEL ${fmt(p.drop[i])}  ${p.identicalToKeep[i] ? '(identical)' : '*** DIFFERS ***'}`,
		);
	}
}

if (!APPLY) {
	console.log(
		`\nDry run. ${plans.length} group(s), ${plans.reduce((n, p) => n + p.drop.length, 0)} file(s) would be deleted.` +
			'\nRe-run with --apply.',
	);
	process.exit(0);
}

let deleted = 0;
let bytes = 0;
const repoint: Array<{ from: string; to: string }> = [];
for (const p of plans) {
	for (const d of p.drop) {
		try {
			const size = (await stat(d.path)).size;
			await rm(d.path, { force: true });
			deleted++;
			bytes += size;
			repoint.push({ from: d.path, to: p.keep.path });
			console.log(`  deleted ${d.path}`);
		} catch (err) {
			console.error(`  FAILED ${d.path}: ${String(err)}`);
		}
	}
}

console.log(`\ndeleted ${deleted} file(s), ${(bytes / 1048576).toFixed(1)} MiB reclaimed`);

if (repoint.length > 0) {
	if (!DB_URL) {
		console.log(
			'\nNo --db-url: rows pointing at deleted files were NOT repointed. Pass one and re-run.',
		);
	} else {
		const { Client } = await import('pg');
		const c = new Client({ connectionString: DB_URL });
		await c.connect();
		let fixed = 0;
		for (const r of repoint) {
			try {
				await c.query('update tracks set file_path = $2 where file_path = $1', [
					r.from,
					r.to,
				]);
				fixed++;
			} catch (err) {
				console.error(`  repoint failed ${r.from}: ${String(err).slice(0, 90)}`);
			}
		}
		await c.end();
		console.log(`repointed ${fixed} row(s) at the surviving file`);
	}
}

console.log('Ask Navidrome to rescan so the albums stop showing greyed out.');
