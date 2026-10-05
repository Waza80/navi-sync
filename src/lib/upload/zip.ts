/**
 * Client-side ZIP expansion for uploads.
 *
 * Expanding in the browser is strictly better than shipping the archive to the
 * server: the server keeps receiving plain audio files over the existing
 * single-file endpoint, a zip bomb is bounded by the browser before a single
 * byte is uploaded, and a 40-track album costs one request per track instead of
 * one huge buffer held in server memory.
 *
 * Implemented against the ZIP spec directly and inflated with the platform's
 * native `DecompressionStream` ('deflate-raw'), so there is no dependency to
 * ship, audit, or keep patched.
 *
 * Everything here treats the archive as hostile: absolute paths, `..`
 * traversal, symlink entries and absurd expansion ratios are refused.
 */

const AUDIO_EXT = new Set([
	'.mp3',
	'.flac',
	'.m4a',
	'.mp4',
	'.aac',
	'.ogg',
	'.opus',
	'.wav',
	'.wma',
]);

/** Caps mirroring the server's own limits. */
const MAX_ENTRIES = 2000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB uncompressed
const MAX_ENTRY_BYTES = 400 * 1024 * 1024;

export interface ExpandedFile {
	/** Basename, safe to hand to the upload endpoint. */
	name: string;
	/** Path inside the archive, e.g. `Artist/Album/01 - Track.flac`. */
	entryPath: string;
	file: File;
	/** Directory-derived metadata hints; a strong signal for untagged rips. */
	hints: { artist: string | null; album: string | null; trackNumber: number | null };
}

export interface ExpandResult {
	files: ExpandedFile[];
	skipped: string[];
}

/** EOCD locator: the end-of-central-directory record, found by reverse scan. */
const EOCD_SIG = 0x06054b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;

/** Central-directory file header signature. */
const CD_SIG = 0x02014b50;
const CD_FIXED_LEN = 46;

/** Local file header signature. */
const LFH_SIG = 0x04034b50;
const LFH_FIXED_LEN = 30;

/** Leading track number, e.g. `01 - Track`, `03. Track`, `07_Track`. */
const LEADING_TRACK = /^\s*(\d{1,3})\s*[-._)\]]*\s+/;

/** `Artist - Title` / `01 - Artist - Title` style basenames. */
export function parseAudioFileName(name: string): {
	title: string;
	artist: string | null;
	trackNumber: number | null;
} {
	const base = name.replace(/\.[^.]+$/, '');
	const m = LEADING_TRACK.exec(base);
	const trackNumber = m ? Number(m[1]) : null;
	const rest = m ? base.slice(m[0].length) : base;
	const parts = rest.split(' - ');
	if (parts.length >= 2) {
		return { title: parts.slice(1).join(' - ').trim(), artist: parts[0].trim(), trackNumber };
	}
	return { title: rest.trim(), artist: null, trackNumber };
}

/**
 * Directory hints from an in-archive path. With the common `Artist/Album/track`
 * (or `Album/track`) shape the directories name the release even when the files
 * carry no tags at all — which is the norm for zipped rips.
 */
export function hintsFromEntryPath(entryPath: string): ExpandedFile['hints'] {
	const segs = entryPath.split(/[/\\]/).filter((s) => s.length > 0);
	const file = segs.pop() ?? '';
	const fileTrack = LEADING_TRACK.exec(file);
	const parent = segs[segs.length - 1] ?? null;
	const grand = segs[segs.length - 2] ?? null;
	const isDiscDir = (s: string | null): boolean =>
		!!s && /^(cd|disc|disk)\s*\d+$/i.test(s.trim());
	let album: string | null = null;
	let artist: string | null = null;
	if (isDiscDir(parent)) {
		album = grand;
		artist = segs.length >= 3 ? (segs[segs.length - 3] ?? null) : null;
	} else {
		album = parent;
		artist = grand;
	}
	return {
		// A `01 - Title` filename proves the parent is an album folder rather than
		// an artist folder, so it must not be read as the artist.
		artist: fileTrack ? null : artist,
		album,
		trackNumber: fileTrack ? Number(fileTrack[1]) : null,
	};
}

function extOf(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function isUnsafeName(name: string): boolean {
	if (!name || name.includes('\0')) return true;
	if (name.startsWith('/') || name.startsWith('\\')) return true;
	if (/^[a-z]:/i.test(name)) return true;
	return name.split(/[/\\]/).some((s) => s === '..');
}

/** Hidden OS droppings and non-audio clutter: ignored silently, not an error. */
function isJunk(entryPath: string): boolean {
	const segs = entryPath.split(/[/\\]/).filter(Boolean);
	if (segs.some((s) => s === '__MACOSX' || s === '.git')) return true;
	const file = segs[segs.length - 1] ?? '';
	return file.startsWith('.') || /\.(txt|lrc|nfo|jpg|jpeg|png|log|db|m3u|cue)$/i.test(file);
}

const decoder = new TextDecoder('utf-8');

/** Locate the EOCD record by scanning backwards over the max comment length. */
function findEocd(view: DataView): number {
	const start = Math.max(0, view.byteLength - EOCD_MIN_SIZE - MAX_COMMENT);
	for (let i = view.byteLength - EOCD_MIN_SIZE; i >= start; i--) {
		if (view.getUint32(i, true) === EOCD_SIG) return i;
	}
	return -1;
}

/** Inflate a raw-deflate member using the platform decompressor. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as unknown as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface CdEntry {
	nameBytes: Uint8Array;
	method: number;
	compressedSize: number;
	uncompressedSize: number;
	localOffset: number;
	isDir: boolean;
	isSymlink: boolean;
}

/**
 * Expand an uploaded `.zip` into individual audio `File`s.
 *
 * Only stored (method 0) and deflated (method 8) members are supported, which
 * covers every ZIP produced by ordinary tools; anything else is reported as
 * skipped rather than silently dropped.
 */
export async function expandZip(file: File): Promise<ExpandResult> {
	const buf = await file.arrayBuffer();
	const view = new DataView(buf);
	const bytes = new Uint8Array(buf);

	const eocd = findEocd(view);
	if (eocd === -1) throw new Error('Not a ZIP archive (no end-of-central-directory record).');

	const total = view.getUint16(eocd + 10, true);
	const cdSize = view.getUint32(eocd + 12, true);
	const cdOffset = view.getUint32(eocd + 16, true);

	// ZIP64: the 32-bit fields saturate and the real values live in the extra
	// record. Detected rather than mis-parsed, so the user gets a clear message.
	if (total === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
		throw new Error('ZIP64 archives are not supported — please zip with a standard tool.');
	}
	if (total > MAX_ENTRIES) {
		throw new Error(`Archive holds ${total} entries; the limit is ${MAX_ENTRIES}.`);
	}

	// ── Read the central directory ─────────────────────────────────────────
	const entries: CdEntry[] = [];
	let p = cdOffset;
	const cdEnd = cdOffset + cdSize;
	for (let i = 0; i < total; i++) {
		if (p + CD_FIXED_LEN > cdEnd || view.getUint32(p, true) !== CD_SIG) {
			throw new Error('Corrupt ZIP central directory.');
		}
		const method = view.getUint16(p + 10, true);
		const compressedSize = view.getUint32(p + 20, true);
		const uncompressedSize = view.getUint32(p + 24, true);
		const nameLen = view.getUint16(p + 28, true);
		const extraLen = view.getUint16(p + 30, true);
		const commentLen = view.getUint16(p + 32, true);
		const externalAttrs = view.getUint32(p + 38, true);
		const localOffset = view.getUint32(p + 42, true);
		const nameBytes = bytes.subarray(p + CD_FIXED_LEN, p + CD_FIXED_LEN + nameLen);
		// Unix mode lives in the high 16 bits; S_IFLNK === 0xA000.
		const isSymlink = ((externalAttrs >>> 16) & 0xf000) === 0xa000;
		entries.push({
			nameBytes,
			method,
			compressedSize,
			uncompressedSize,
			localOffset,
			isDir: nameBytes.length > 0 && nameBytes[nameBytes.length - 1] === 0x2f,
			isSymlink,
		});
		p += CD_FIXED_LEN + nameLen + extraLen + commentLen;
	}

	// ── Filter, then extract ───────────────────────────────────────────────
	const files: ExpandedFile[] = [];
	const skipped: string[] = [];
	let budget = MAX_TOTAL_BYTES;

	for (const e of entries) {
		const entryPath = decoder.decode(e.nameBytes);
		if (e.isDir) continue;
		if (isUnsafeName(entryPath)) {
			skipped.push(`${entryPath} (unsafe path)`);
			continue;
		}
		if (isJunk(entryPath)) continue;
		if (e.isSymlink) {
			skipped.push(`${entryPath} (symlink)`);
			continue;
		}
		const ext = extOf(entryPath);
		if (!AUDIO_EXT.has(ext)) {
			skipped.push(`${entryPath} (unsupported type)`);
			continue;
		}
		if (e.uncompressedSize > MAX_ENTRY_BYTES) {
			skipped.push(`${entryPath} (file too large)`);
			continue;
		}
		if (e.method !== 0 && e.method !== 8) {
			skipped.push(`${entryPath} (unsupported compression)`);
			continue;
		}
		budget -= e.uncompressedSize;
		if (budget < 0) throw new Error('Archive expands beyond the 2 GiB limit.');

		// The local header repeats the name/extra with its own lengths, which is
		// where the payload actually starts.
		if (e.localOffset + LFH_FIXED_LEN > buf.byteLength) {
			skipped.push(`${entryPath} (truncated)`);
			continue;
		}
		if (view.getUint32(e.localOffset, true) !== LFH_SIG) {
			skipped.push(`${entryPath} (bad local header)`);
			continue;
		}
		const lfhNameLen = view.getUint16(e.localOffset + 26, true);
		const lfhExtraLen = view.getUint16(e.localOffset + 28, true);
		const start = e.localOffset + LFH_FIXED_LEN + lfhNameLen + lfhExtraLen;
		const end = start + e.compressedSize;
		if (end > buf.byteLength) {
			skipped.push(`${entryPath} (truncated)`);
			continue;
		}
		const raw = bytes.subarray(start, end);

		let out: Uint8Array;
		try {
			out = e.method === 0 ? raw : await inflateRaw(raw);
		} catch (err) {
			skipped.push(`${entryPath} (${String(err).slice(0, 50)})`);
			continue;
		}
		if (out.byteLength === 0) {
			skipped.push(`${entryPath} (empty)`);
			continue;
		}

		const segs = entryPath.split(/[/\\]/).filter(Boolean);
		const name = segs[segs.length - 1] ?? entryPath;
		files.push({
			name,
			entryPath,
			// A plain Blob keeps memory bounded vs. constructing a File per entry
			// eagerly; `File` is only needed at the FormData boundary.
			file: new File([out as unknown as BlobPart], name, {
				type: ext === '.flac' ? 'audio/flac' : 'audio/mpeg',
			}),
			hints: hintsFromEntryPath(entryPath),
		});
	}

	return { files, skipped };
}

/** True when a picked file should be routed through the ZIP expander. */
export function isZip(name: string): boolean {
	return extOf(name) === '.zip';
}
