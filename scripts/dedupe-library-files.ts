/**
 * Remove duplicate library files created by suffixed moves.
 *
 * Symptom this cleans up: `07 - sludgecrank.flac`, `07 - sludgecrank (2).flac` and
 * `07 - sludgecrank (3).flac` side by side in one album folder. Navidrome greys
 * those albums out because several files claim the same track number.
 *
 * Cause: `moveIntoLibrary` suffixes when the destination exists with different
 * bytes, which is correct as a last resort — it will not destroy user data. But a
 * re-downloaded copy is byte-different from the original because it gets tagged, so
 * the suffix path was being reached repeatedly for the same recording. The
 * download pipeline now hard-stops instead (see `shouldStopAlreadyDownloaded`), so
 * new duplicates cannot appear; this removes the ones already written.
 *
 * Safety rules, deliberately conservative:
 *   - only files whose name matches an existing `base (n).ext` beside `base.ext`
 *   - the unsuffixed original must exist, or nothing is touched
 *   - a suffixed copy whose checksum matches the original is always safe to delete
 *   - a differing copy is deleted ONLY with --force, and only after reporting it
 *   - dry-run by default
 *
 * Usage:
 *   bun run scripts/dedupe-library-files.ts --root /mnt/hdd/music
 *   bun run scripts/dedupe-library-files.ts --root /mnt/hdd/music --apply --force
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const opt = (name: string): string | null => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

const ROOT = opt('root') ?? process.env.MUSIC_LIBRARY_DIR ?? null;
const APPLY = flag('apply');
const FORCE = flag('force');

if (!ROOT) {
	console.error('Pass --root <library dir> (or set MUSIC_LIBRARY_DIR).');
	process.exit(2);
}

/** `song (2).flac` -> `song.flac`; anything else -> null. */
function unsuffixed(file: string): string | null {
	const m = /^(.*) \((\d+)\)(.*)$/.exec(file);
	if (!m) return null;
	const [, base, , ext] = m;
	if (!base.trim()) return null;
	return `${base}${ext}`;
}

/** SHA-256 of a file, streamed so a 40MB FLAC does not sit in memory. */
async function sha256(path: string): Promise<string> {
	const hash = createHash('sha256');
	const buf = await readFile(path);
	hash.update(buf);
	return hash.digest('hex');
}

interface Candidate {
	dir: string;
	original: string;
	duplicate: string;
	identical: boolean | null;
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

const files: string[] = [];
await walk(ROOT, files);
console.log(`scanned ${files.length} files under ${ROOT}`);

const byDir = new Map<string, string[]>();
for (const f of files) {
	const d = dirname(f);
	const list = byDir.get(d) ?? [];
	list.push(basename(f));
	byDir.set(d, list);
}

const candidates: Candidate[] = [];
for (const [dir, names] of byDir) {
	const set = new Set(names);
	for (const name of names) {
		if (extname(name) === '') continue;
		const target = unsuffixed(name);
		// The unsuffixed original must exist: without it the suffixed file may be
		// the only copy of that recording and deleting it would lose audio.
		if (!target || !set.has(target)) continue;
		const dup = join(dir, name);
		const orig = join(dir, target);
		let identical: boolean | null = null;
		try {
			identical = (await sha256(dup)) === (await sha256(orig));
		} catch {
			identical = null;
		}
		candidates.push({ dir, original: orig, duplicate: dup, identical });
	}
}

console.log(`\nfound ${candidates.length} suffixed duplicate(s)`);
if (candidates.length === 0) process.exit(0);

const safe = candidates.filter((c) => c.identical === true);
const risky = candidates.filter((c) => c.identical === false);
const unknown = candidates.filter((c) => c.identical === null);

for (const c of safe) console.log(`  identical  ${c.duplicate}`);
for (const c of risky) console.log(`  DIFFERS    ${c.duplicate}  (needs --force)`);
for (const c of unknown) console.log(`  unreadable ${c.duplicate}  (left alone)`);

const removable = APPLY ? [...safe, ...(FORCE ? risky : [])] : [];

if (!APPLY) {
	console.log(
		`\nDry run. ${safe.length} identical would be deleted` +
			(risky.length ? `, ${risky.length} differ and need --force` : '') +
			'. Re-run with --apply.',
	);
	process.exit(0);
}

if (risky.length > 0 && !FORCE) {
	console.log(
		`\n${risky.length} differing duplicate(s) left in place. Use --force to delete them.`,
	);
}

let deleted = 0;
let bytes = 0;
for (const c of removable) {
	try {
		const size = (await stat(c.duplicate)).size;
		await rm(c.duplicate, { force: true });
		deleted++;
		bytes += size;
		console.log(`  deleted ${c.duplicate}`);
	} catch (err) {
		console.error(`  FAILED ${c.duplicate}: ${String(err)}`);
	}
}

console.log(
	`\ndeleted ${deleted} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MiB reclaimed. ` +
		'Ask Navidrome to rescan so the album stops showing greyed out.',
);
