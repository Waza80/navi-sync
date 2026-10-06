/**
 * Rebuild `tracks` rows from the files on disk.
 *
 * EMERGENCY RECOVERY. The library index was destroyed by a bulk delete that ran
 * against an unverified existence probe: the audio was never touched, but every
 * filed row went with it. This reconstructs the rows from what IS on disk.
 *
 * What is recovered from the filesystem:
 *   artist / album      — the directory structure
 *   track number, title — the "NN - Title.ext" filename
 *   format, bit depth, sample rate, bitrate — read from the file's own header
 *   size, checksum      — stat + sha256
 *   cover path          — cover.jpg beside the audio
 *   lyrics status       — whether a .lrc/.txt sidecar exists
 *
 * What CANNOT be recovered from disk, and is left null for a metadata reindex to
 * fill: ISRC, release year, genre, album artist, and the provider link. The
 * reindex endpoint exists precisely for this.
 *
 * `provider_track_id` is synthesised as `local:<sha256-prefix>`. It must not be a
 * URL (see db/validate.ts) and must be unique, and a content hash gives both
 * without pretending to know which provider supplied the file.
 *
 * Safety: dry-run by default. `--apply` inserts inside one transaction that rolls
 * back on any error, and it refuses to run if any rows already have a file_path —
 * restoring over a populated index would duplicate it.
 */
import { createHash } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';
import { Client } from 'pg';

const args = process.argv.slice(2);
const flag = (n: string): boolean => args.includes(`--${n}`);
const opt = (n: string): string | null => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const ROOT = opt('root');
const APPLY = flag('apply');
const DB_URL = opt('db-url');

if (!ROOT) {
	console.error('Usage: --root <library dir> [--db-url <url>] [--apply]');
	process.exit(2);
}

const AUDIO = new Set(['.flac', '.mp3', '.wav', '.aiff', '.aif', '.m4a', '.ogg', '.opus']);

interface Row {
	provider: string;
	providerTrackId: string;
	title: string;
	artist: string;
	album: string | null;
	albumArtist: string | null;
	trackNumber: number | null;
	discNumber: number | null;
	releaseYear: number | null;
	genre: string | null;
	durationSec: number | null;
	format: string;
	bitrateKbps: number | null;
	bitDepth: number | null;
	sampleRateHz: number | null;
	isLossless: boolean;
	sizeBytes: number;
	checksumSha256: string;
	filePath: string;
	coverPath: string | null;
	lyricsStatus: string;
	downloadStatus: string;
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

interface FlacInfo {
	bitDepth?: number | null;
	sampleRate?: number | null;
	durationSec?: number | null;
}
interface WavInfo {
	bitDepth?: number | null;
	sampleRate?: number | null;
}

/** FLAC STREAMINFO. The block header sits right after the 4-byte "fLaC" magic. */
async function probeFlac(path: string): Promise<FlacInfo> {
	const handle = await open(path, 'r');
	try {
		const head = Buffer.alloc(42);
		await handle.read(head, 0, 42, 0);
		if (head.subarray(0, 4).toString('latin1') !== 'fLaC') return {};
		let p = 4;
		while (p + 4 <= head.length) {
			const type = head[p] & 0x7f;
			const len = ((head[p + 1] & 0x7f) << 16) | (head[p + 2] << 8) | head[p + 3];
			if (type === 0) {
				const b = head.subarray(p + 4, p + 4 + 18);
				if (b.length < 14) return {};
				const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
				const bitDepth = (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1;
				// 36-bit total sample count: low 4 bits of b[13], then b[14..17].
				// Computed with Number rather than BigInt so it runs on the ES2019
				// target this project compiles to; 36 bits is exact in a double.
				const total =
					((b[13] & 0x0f) * 2 ** 32 +
						b[14] * 2 ** 24 +
						b[15] * 2 ** 16 +
						b[16] * 2 ** 8 +
						b[17]) >>>
					0;
				const durationSec = sampleRate > 0 ? total / sampleRate : null;
				return { bitDepth, sampleRate, durationSec: durationSec ?? null };
			}
			p += 4 + len;
			if ((head[p - 4 - len] & 0x80) !== 0) break;
		}
		return {};
	} finally {
		await handle.close();
	}
}

/** RIFF/WAVE fmt chunk. */
async function probeWav(
	path: string,
): Promise<{ bitDepth: number | null; sampleRate: number | null }> {
	const handle = await open(path, 'r');
	try {
		const head = Buffer.alloc(64);
		await handle.read(head, 0, 64, 0);
		const i = head.toString('latin1').indexOf('fmt ');
		if (i < 0 || i + 24 > head.length) return {};
		return { bitDepth: head.readUInt16LE(i + 14), sampleRate: head.readUInt32LE(i + 4) };
	} finally {
		await handle.close();
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

/** "07 - Title" -> {trackNumber: 7, title: "Title"}; tolerates no number. */
function splitFilename(stem: string): { trackNumber: number | null; title: string } {
	const m = /^(\d{1,3})\s*[-–—]\s*(.+)$/.exec(stem);
	if (!m) return { trackNumber: null, title: stem.trim() || 'Unknown Title' };
	const n = Number.parseInt(m[1], 10);
	return {
		trackNumber: Number.isFinite(n) ? n : null,
		title: m[2].trim() || 'Unknown Title',
	};
}

const files: string[] = [];
await walk(ROOT, files);
const audio = files.filter((f) => AUDIO.has(extname(f).toLowerCase()));
console.log(`root ${ROOT}: ${files.length} files, ${audio.length} audio`);

const rows: Row[] = [];
let noSidecar = 0;

for (const abs of audio) {
	const rel = relative(ROOT, abs);
	const parts = rel.split(sep);
	const ext = extname(abs).toLowerCase();
	const stem = rel.slice(0, rel.length - ext.length);
	const sp = stem.split(sep);

	// <artist>/<album>/NN - Title
	let artist = 'Unknown Artist';
	let album: string | null = null;
	if (sp.length >= 3) {
		artist = sp[sp.length - 3];
		album = sp[sp.length - 2];
	} else if (sp.length === 2) {
		artist = sp[0];
	}
	const { trackNumber, title } = splitFilename(sp[sp.length - 1]);

	const size = (await stat(abs)).size;
	let bitDepth: number | null = null;
	let sampleRate: number | null = null;
	let durationSec: number | null = null;
	if (ext === '.flac') ({ bitDepth, sampleRate, durationSec } = await probeFlac(abs));
	else if (ext === '.wav' || ext === '.aiff' || ext === '.aif')
		({ bitDepth, sampleRate } = await probeWav(abs));

	const checksum = await sha256(abs);
	const dir = dirname(abs);

	// Cover art lives beside the audio, shared per album.
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

	let lyricsStatus = 'none';
	for (const l of ['lrc', 'txt']) {
		const lp = `${abs.slice(0, abs.length - ext.length)}.${l}`;
		if (
			await stat(lp).then(
				() => true,
				() => false,
			)
		) {
			lyricsStatus = 'plain';
			break;
		}
	}
	if (lyricsStatus === 'none') noSidecar++;

	rows.push({
		provider: 'local',
		// Content-addressed: unique, stable, and never a URL. The real provider
		// link is unknown after this recovery and is filled in by a reindex.
		providerTrackId: `local:${checksum.slice(0, 32)}`,
		title,
		artist,
		album,
		albumArtist: artist,
		trackNumber,
		discNumber: null,
		releaseYear: null,
		genre: null,
		durationSec: durationSec == null ? null : Math.round(durationSec),
		format: ext.replace('.', ''),
		bitrateKbps: null,
		bitDepth,
		sampleRateHz: sampleRate,
		isLossless: ext === '.flac' || ext === '.wav' || ext === '.aiff' || ext === '.aif',
		sizeBytes: size,
		checksumSha256: checksum,
		filePath: abs,
		coverPath,
		lyricsStatus,
		downloadStatus: 'completed',
	});
}

console.log(`parsed ${rows.length} row(s); ${noSidecar} without a lyrics sidecar`);
const bitDepths = new Map<number, number>();
for (const r of rows) bitDepths.set(r.bitDepth ?? 0, (bitDepths.get(r.bitDepth ?? 0) ?? 0) + 1);
console.log('bit depths:', JSON.stringify([...bitDepths.entries()].sort((a, b) => b[1] - a[1])));
console.log(`sample: ${JSON.stringify(rows[0], null, 1)}`);

if (!APPLY) {
	console.log('\nDry run. Re-run with --db-url and --apply to write.');
	process.exit(0);
}
if (!DB_URL) {
	console.error('\n--apply needs --db-url.');
	process.exit(2);
}

const client = new Client({ connectionString: DB_URL });
await client.connect();

// ROLLBACK_ONLY rehearses the entire insert against the real schema and then
// throws it away. The library index was destroyed by an unverified bulk write once
// already, so this makes it possible to prove the SQL is valid and to count what
// WOULD be inserted without persisting a row.
const ROLLBACK_ONLY = process.env.ROLLBACK_ONLY === '1';

// Refuse to restore over a populated index: that is the mistake that caused this.
const existing = await client.query(
	'select count(*)::int n from tracks where file_path is not null',
);
if ((existing.rows[0]?.n ?? 0) > 0) {
	console.error(
		`Refusing to restore: ${existing.rows[0].n} row(s) already have a file_path. ` +
			'Restoring now would duplicate the index.',
	);
	await client.end();
	process.exit(3);
}

await client.query('BEGIN');
try {
	const COLUMNS = [
		'provider',
		'provider_track_id',
		'title',
		'artist',
		'album',
		'album_artist',
		'track_number',
		'disc_number',
		'release_year',
		'genre',
		'duration_sec',
		'format',
		'bitrate_kbps',
		'bit_depth',
		'sample_rate_hz',
		'is_lossless',
		'size_bytes',
		'checksum_sha256',
		'file_path',
		'cover_path',
		'lyrics_status',
		'download_status',
	] as const;

	const CHUNK = 40;
	for (let i = 0; i < rows.length; i += CHUNK) {
		const slice = rows.slice(i, i + CHUNK);
		const values: unknown[] = [];
		const tuples = slice.map((r) => {
			const tuple = [
				r.provider,
				r.providerTrackId,
				r.title,
				r.artist,
				r.album,
				r.albumArtist,
				r.trackNumber,
				r.discNumber,
				r.releaseYear,
				r.genre,
				r.durationSec,
				r.format,
				r.bitrateKbps,
				r.bitDepth,
				r.sampleRateHz,
				r.isLossless,
				r.sizeBytes,
				r.checksumSha256,
				r.filePath,
				r.coverPath,
				r.lyricsStatus,
				r.downloadStatus,
			];
			const placeholders = tuple.map((_, col) => {
				values.push(tuple[col]);
				return `$${values.length}`;
			});
			return `(${placeholders.join(',')})`;
		});
		await client.query(
			`insert into tracks (${COLUMNS.join(', ')}) values ${tuples.join(',')}`,
			values,
		);
	}
	if (ROLLBACK_ONLY) {
		const staged = await client.query('select count(*)::int n from tracks');
		await client.query('ROLLBACK');
		const after = await client.query(
			'select count(*)::int n from tracks where file_path is not null',
		);
		console.log(
			`\nREHEARSAL ONLY - rolled back. Would have inserted ${
				staged.rows[0].n - existing.rows[0].n
			} row(s); filed rows still ${after.rows[0].n}.`,
		);
		process.exit(0);
	}

	await client.query('COMMIT');
	const after = await client.query(
		'select count(*)::int n from tracks where file_path is not null',
	);
	console.log(`\nrestored ${after.rows[0].n} row(s)`);
} catch (err) {
	await client.query('ROLLBACK');
	console.error('restore failed, rolled back:', err instanceof Error ? err.message : String(err));
	await client.end();
	process.exit(1);
}
await client.end();
console.log('Run the metadata reindex to fill ISRC, year, genre and cover art.');
