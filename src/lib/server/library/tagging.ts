import * as NodeID3 from 'node-id3';
import { createReadStream, createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { Processor, data as flacData } from 'flac-metadata';
import type { MetaDataBlockVorbisComment } from 'flac-metadata';
import { parseFile } from 'music-metadata';
import { logger } from '$lib/server/logger';

const log = logger;
const execFileAsync = promisify(execFile);

export interface TagData {
	title: string;
	artist: string;
	album: string | null;
	albumArtist: string | null;
	trackNumber: number | null;
	discNumber: number | null;
	year: number | null;
	genre: string | null;
	/** JPEG/PNG bytes to embed, if available. */
	cover: Buffer | null;
	lyricsPlain: string | null;
	/**
	 * Timestamped lyrics (LRC format) to embed alongside `lyricsPlain`.
	 *
	 * Navidrome does not read .lrc sidecar files — only tags — so without this
	 * the dashboard shows lyrics while Navidrome reports "No lyrics". The
	 * sidecar is still written for other players.
	 */
	lyricsSynced: string | null;
}

export interface ProbedQuality {
	container: string;
	codec: string | null;
	bitrateKbps: number | null;
	sampleRateHz: number | null;
	bitDepth: number | null;
	durationSec: number | null;
	lossless: boolean;
}

/**
 * Tag an MP3 in place (ID3v2.4, TCON genre, USLT lyrics, APIC art).
 *
 * Two node-id3 landmines, both hit here in anger:
 *
 * 1. A key present with an `undefined` value is NOT the same as an absent key.
 *    node-id3 iterates the object's own keys and dereferences each one, so
 *    `{ synchronisedLyrics: undefined }` throws `TypeError: undefined is not an
 *    object (evaluating 'lycics.language')` — an upstream typo. Because the
 *    throw escaped before any frame was written, EVERY MP3 upload was stored
 *    completely untagged (Navidrome then could not identify the files at all).
 *    So the frame map is filtered down to defined values before writing.
 *
 * 2. `synchronisedLyrics` (SYLT) is unusable in this version — it demands an
 *    integer `timestamp` and throws `RangeError: An integer value is expected`
 *    for any real payload. Synced lyrics are therefore carried in a USLT frame
 *    with the LRC timestamps left inline, which is exactly what Navidrome's
 *    `mappings.yaml` reads (`lyrics` aliases `uslt:description`).
 */
export function tagMp3(path: string, tags: TagData): void {
	const frames: Record<string, unknown> = {
		title: nfc(tags.title),
		artist: nfc(tags.artist),
		album: nfc(tags.album),
		// performerInfo is the TPE2 frame — the album artist. Without it Navidrome
		// falls back to the track ARTIST for album grouping, so any release whose
		// tracks credit different artists splits into one album per credit string.
		performerInfo: nfc(tags.albumArtist),
		trackNumber: tags.trackNumber != null ? String(tags.trackNumber) : undefined,
		partOfSet: tags.discNumber != null ? String(tags.discNumber) : undefined,
		year: tags.year != null ? String(tags.year) : undefined,
		genre: nfc(tags.genre),
	};
	// Prefer synced (timestamped) lyrics when present, else the plain text.
	//
	// This must be the DESCRIPTOR-LESS USLT frame (`unsynchronisedLyrics`).
	// Navidrome's mappings.yaml reads lyrics via the aliases
	// `[uslt:description, lyrics, unsyncedlyrics]` — a USLT carrying a
	// descriptor is keyed by that description and never reaches `lyrics`,
	// which is why lyrics written as node-id3's `lyrics` frame were invisible.
	// Timestamps are kept inline so Navidrome can tell synced from unsynced.
	const lrc = tags.lyricsSynced ?? tags.lyricsPlain;
	if (lrc) {
		frames.unsynchronisedLyrics = { language: 'eng', text: lrc.replace(/\r/g, '') };
	}
	if (tags.cover) {
		frames.image = {
			mime: 'image/jpeg',
			type: 3,
			description: 'Cover',
			imageBuffer: tags.cover,
		};
	}
	// Drop undefined-valued keys — see landmine 1 above.
	for (const key of Object.keys(frames)) {
		if (frames[key] === undefined) delete frames[key];
	}
	NodeID3.removeTags(path);
	const written = NodeID3.write(frames, path);
	if (written instanceof Error) throw written;
}

/**
 * Canonicalise a tag value to NFC before it is written.
 *
 * Paths are already normalised (`sanitizeComponent` calls `.normalize('NFC')`)
 * so one album can only produce ONE folder, but the tag writers used to pass
 * provider strings through verbatim. Providers hand back the same album title
 * with the combining marks in different orders depending on the track, and
 * Navidrome keys album identity on the raw tag BYTES — so a Zalgo release came
 * out as two albums, `chars=62` and `chars=60`, both `bytes=115`, in one
 * directory. Normalising here makes the tag agree with the folder it lives in.
 */
function nfc(value: string | null | undefined): string | undefined {
	return value == null ? undefined : value.normalize('NFC');
}

/**
 * Build canonical Vorbis comment fields from tag data (pure — unit-tested).
 * Store downloads carry junk or empty tags (e.g. a lone "Processed by SoX"
 * comment), which is exactly why Navidrome shows [Unknown] artists/albums.
 */
export function buildVorbisFields(tags: TagData): Array<[string, string]> {
	const fields: Array<[string, string]> = [
		['TITLE', nfc(tags.title)!],
		['ARTIST', nfc(tags.artist)!],
	];
	const album = nfc(tags.album);
	const albumArtist = nfc(tags.albumArtist);
	if (album) fields.push(['ALBUM', album]);
	if (albumArtist) fields.push(['ALBUMARTIST', albumArtist]);
	if (tags.trackNumber != null) fields.push(['TRACKNUMBER', String(tags.trackNumber)]);
	if (tags.discNumber != null) fields.push(['DISCNUMBER', String(tags.discNumber)]);
	if (tags.year != null) fields.push(['DATE', String(tags.year)]);
	const genre = nfc(tags.genre);
	if (genre) fields.push(['GENRE', genre]);
	if (tags.lyricsPlain) fields.push(['LYRICS', tags.lyricsPlain.replace(/\r/g, '')]);
	// Also write the timestamped form. Navidrome reads USLT/UNSYNCEDLYRICS for
	// plain lyrics but shows nothing at all when only a .lrc sidecar exists —
	// it never reads sidecar files. Writing LRC (synced) alongside LYRICS lets
	// Navidrome display and highlight lyrics for every track we have them for.
	if (tags.lyricsSynced) fields.push(['LRC', tags.lyricsSynced.replace(/\r/g, '')]);
	return fields;
}

/**
 * Tag a FLAC with metaflac: wipes junk tags, writes canonical fields, creates
 * the VORBIS_COMMENT block when missing, and embeds the cover. Falls back to
 * the stream processor only when the metaflac binary is absent (it can only
 * mutate an existing block — files without one stay untagged).
 */
/**
 * Tag fields that can contain newlines.
 *
 * metaflac's `--set-tag=NAME=value` stores only the FIRST LINE of a value, so
 * multi-line lyrics must be passed via `--set-tag-from-file`. Everything else is
 * single-line and goes through the normal argument path.
 */
const MULTILINE_FIELDS = new Set(['LYRICS', 'LRC']);

export async function tagFlac(path: string, tags: TagData): Promise<void> {
	const args = ['--remove-all-tags'];
	// Temp files for newline-bearing values, removed in the finally block.
	const scratch: string[] = [];
	for (const [name, value] of buildVorbisFields(tags)) {
		if (MULTILINE_FIELDS.has(name) && /[\r\n]/.test(value)) {
			const tmp = `${path}.${name.toLowerCase()}.tmp`;
			await writeFile(tmp, value, 'utf8');
			scratch.push(tmp);
			args.push(`--set-tag-from-file=${name}=${tmp}`);
			continue;
		}
		args.push(`--set-tag=${name}=${value}`);
	}
	let coverTmp: string | null = null;
	if (tags.cover) {
		coverTmp = `${path}.cover.tmp`;
		await writeFile(coverTmp, tags.cover);
		// Empty dimensions are accepted — metaflac fills them in.
		args.push(`--import-picture-from=3|image/jpeg|||${coverTmp}`);
	}
	args.push(path);
	try {
		// --no-utf8-convert is REQUIRED, and is the actual fix.
		//
		// By default metaflac converts every tag value from UTF-8 to the
		// LOCAL CHARSET. The slim image has no locales installed, so LC_CTYPE is
		// "C" and each non-ASCII byte becomes an unmappable '#': "Björk" ->
		// "Bj##rk", and a zalgo album became "#CUT4#####Z###A###L###". The env
		// vars below are a belt-and-braces measure; the flag alone is sufficient
		// and keeps tagging correct even if the image's locale changes.
		await execFileAsync('metaflac', ['--no-utf8-convert', ...args], {
			timeout: 30_000,
			env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
		});
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
			log.debug('metaflac not found, using stream tagger', { path });
			await tagFlacStream(path, tags);
		} else {
			throw err;
		}
	} finally {
		if (coverTmp) await unlink(coverTmp).catch(() => undefined);
		for (const f of scratch) await unlink(f).catch(() => undefined);
	}
}

/**
 * Rewrite Vorbis comments for FLAC via the flac-metadata stream processor.
 * The processor re-emits each metadata block; we mutate the VORBIS_COMMENT
 * block in place. Only used when metaflac is unavailable.
 */
export async function tagFlacStream(path: string, tags: TagData): Promise<void> {
	const comments: string[] = buildVorbisFields(tags).map(([name, value]) => `${name}=${value}`);

	let applied = false;
	const processor = new Processor();
	processor.on('preprocess', (mdb) => {
		if (mdb.type === Processor.MDB_TYPE_VORBIS_COMMENT) {
			const vc = mdb as unknown as MetaDataBlockVorbisComment;
			vc.vendor = 'NaviSync 0.1.0';
			vc.comments = comments;
			applied = true;
		}
	});
	// Pass-through stream keeps types happy between processor and writer.
	const passthrough = new Transform({
		transform(chunk, _enc, cb) {
			cb(null, chunk);
		},
	});

	const tmpPath = `${path}.tagging.tmp`;
	await pipeline(createReadStream(path), processor, passthrough, createWriteStream(tmpPath));
	await rename(tmpPath, path);

	if (!applied) {
		log.warn('flac had no vorbis-comment block; embedded tags skipped', { path });
	}
	void flacData; // namespace re-exported for future picture embedding
}

/**
 * Ensure a library file carries usable embedded tags, repairing from
 * canonical data when the file's own tags are missing/empty. Returns what
 * happened — the repair flow aggregates these counts.
 *
 * `force` rewrites tags even when the file already has a title+artist, which
 * is what metadata enrichment needs after it discovers a previously unknown
 * album, genre or track number.
 */
export async function ensureFileTags(
	filePath: string,
	tags: TagData,
	opts: { force?: boolean } = {},
): Promise<'ok' | 'skipped' | 'failed'> {
	try {
		const ext = filePath.toLowerCase().endsWith('.flac') ? 'flac' : 'mp3';
		if (!opts.force) {
			const info = await parseFile(filePath, { duration: false }).catch(() => null);
			const c = info?.common;
			if (c?.title && c?.artist) return 'skipped';
		}
		if (ext === 'flac') await tagFlac(filePath, tags);
		else tagMp3(filePath, tags);
		log.info('repaired embedded tags', { filePath, force: opts.force ?? false });
		return 'ok';
	} catch (err) {
		log.warn('tag repair failed', { filePath, error: String(err) });
		return 'failed';
	}
}

/** Probe real audio properties — DB stores measured values, not claims. */
export async function probeQuality(path: string): Promise<ProbedQuality> {
	const info = await parseFile(path, { duration: true });
	const f = info.format;
	const container = (f.container ?? '').toLowerCase();
	const lossless = ['flac', 'ape', 'alac', 'wav', 'aiff'].includes(container);
	const bitrate = f.bitrate ? Math.round(f.bitrate / 1000) : null;
	return {
		container,
		codec: f.codec ?? null,
		bitrateKbps: bitrate,
		sampleRateHz: f.sampleRate ?? null,
		bitDepth: f.bitsPerSample ?? null,
		durationSec: f.duration ? Math.round(f.duration) : null,
		lossless,
	};
}

/** Fetch cover art bytes; returns null on any failure (art is optional). */
export async function fetchCover(url: string | null): Promise<Buffer | null> {
	if (!url) return null;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
		if (!res.ok) return null;
		const buf = Buffer.from(await res.arrayBuffer());
		// Sanity: reject non-image or absurd payloads.
		if (buf.length < 1024 || buf.length > 15 * 1024 * 1024) return null;
		return buf;
	} catch (err) {
		log.debug('cover fetch failed', { error: String(err) });
		return null;
	}
}
