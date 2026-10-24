import * as NodeID3 from 'node-id3';
import { createReadStream, createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { readLyricsSidecar } from '$lib/server/lyrics/sidecar';
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
	 * Timestamped lyrics (LRC format). Written to the ONE lyrics tag Navidrome
	 * reads; see `buildVorbisFields` for why the stamps must be in that tag.
	 *
	 * The sidecar is still written for other players.
	 */
	lyricsSynced: string | null;
	/**
	 * MusicBrainz identities. Optional because uploads and files that predate the
	 * columns have none — a missing identity is simply not written, never
	 * invented. They map to the standard Picard field names
	 * (`MUSICBRAINZ_TRACKID`, `MUSICBRAINZ_RELEASETRACKID`, …) so Navidrome and
	 * every scrobbler that already understands those tags understands these.
	 */
	artistMbid?: string | null;
	recordingMbid?: string | null;
	releaseMbid?: string | null;
	releaseGroupMbid?: string | null;
	albumArtistMbid?: string | null;
	releaseTrackMbid?: string | null;
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
	// MusicBrainz identities live in TXXX frames on ID3, under the exact
	// descriptions Picard writes. Navidrome's ID3 mapping reads these; the Vorbis
	// names above are for FLAC. `userDefinedText` is an array because TXXX is
	// repeatable — building it as an object silently keeps only one frame.
	const mbFrames = (
		[
			['MusicBrainz Artist Id', tags.artistMbid],
			['MusicBrainz Album Artist Id', tags.albumArtistMbid],
			['MusicBrainz Track Id', tags.recordingMbid],
			['MusicBrainz Release Track Id', tags.releaseTrackMbid],
			['MusicBrainz Album Id', tags.releaseMbid],
			['MusicBrainz Release Group Id', tags.releaseGroupMbid],
		] as Array<[string, string | null | undefined]>
	)
		.filter(
			(entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
		)
		.map(([description, value]) => ({ description, value }));
	if (mbFrames.length > 0) frames.userDefinedText = mbFrames;
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
			mime: coverMimeOf(tags.cover),
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
 * MIME type of cover bytes, from the bytes themselves.
 *
 * Hardcoding `image/jpeg` labelled every PNG cover as a JPEG. Navidrome and
 * browsers sniff the payload anyway, so nothing broke visibly, but the tag was
 * simply wrong — and a wrong tag is what a re-import turns into a wrong picture.
 */
function coverMimeOf(bytes: Buffer): string {
	if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
		return 'image/png';
	}
	return 'image/jpeg';
}

/** First embedded picture, as bytes, for the writers to re-embed. */
function embeddedPicture(common: Record<string, unknown> | null): Buffer | null {
	const pics = (common?.picture as Array<{ data?: Uint8Array }> | undefined) ?? [];
	const data = pics[0]?.data;
	return data && data.length > 0 ? Buffer.from(data) : null;
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
	// MusicBrainz identities, under the names Picard writes and Navidrome reads.
	// Only present values are written: a blank MBID tag is worse than none,
	// because a consumer cannot tell "unknown" from "the empty string".
	if (tags.artistMbid) fields.push(['MUSICBRAINZ_ARTISTID', tags.artistMbid]);
	if (tags.albumArtistMbid) fields.push(['MUSICBRAINZ_ALBUMARTISTID', tags.albumArtistMbid]);
	// MUSICBRAINZ_TRACKID is the RECORDING id; the release track id is separate.
	if (tags.recordingMbid) fields.push(['MUSICBRAINZ_TRACKID', tags.recordingMbid]);
	if (tags.releaseTrackMbid) fields.push(['MUSICBRAINZ_RELEASETRACKID', tags.releaseTrackMbid]);
	if (tags.releaseMbid) fields.push(['MUSICBRAINZ_ALBUMID', tags.releaseMbid]);
	if (tags.releaseGroupMbid) fields.push(['MUSICBRAINZ_RELEASEGROUPID', tags.releaseGroupMbid]);
	// ONE lyrics tag, and it must carry the timestamps when we have them.
	//
	// Navidrome reads exactly one tag here: `LYRICS` (mappings.yaml aliases are
	// `uslt:description`, `lyrics`, `unsyncedlyrics`). `LRC` is NOT one of them,
	// so writing the synced copy there hid it completely — what reached Navidrome
	// was the plain text under `LYRICS`, which it indexes as `"synced": false`.
	// Its web player only renders entries whose `synced` is true, so even the
	// tracks that did carry a lyrics tag showed nothing.
	//
	// Navidrome's `model.ParseLyrics` falls through to the LRC parser and sets
	// `synced` from the presence of `[mm:ss.xx]` stamps, so the stamps belong in
	// `LYRICS` itself. Plain text is only the fallback when no synced form exists.
	const lyrics = tags.lyricsSynced ?? tags.lyricsPlain;
	if (lyrics) fields.push(['LYRICS', lyrics.replace(/\r/g, '')]);
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
const MULTILINE_FIELDS = new Set(['LYRICS']);

export async function tagFlac(path: string, tags: TagData): Promise<void> {
	// `--remove-all-tags` also deletes the PICTURE block. Every whole-library
	// re-tag path passes `cover: null` (the art lives in cover_path and is not
	// read back), so a forced pass would strip the embedded cover from every
	// FLAC while reporting success. When no replacement bytes are supplied,
	// export the existing picture first and re-import it after the rewrite, so
	// cleaning the junk comments costs no artwork.
	let preserved: string | null = null;
	if (!tags.cover) {
		const tmp = `${path}.keepcover.tmp`;
		try {
			await execFileAsync(
				'metaflac',
				['--no-utf8-convert', `--export-picture-to=${tmp}`, path],
				{ timeout: 30_000, env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } },
			);
			// metaflac exits 0 and writes nothing when the file has no picture.
			if (
				await stat(tmp)
					.then(() => true)
					.catch(() => false)
			)
				preserved = tmp;
		} catch {
			// No picture to preserve — nothing to do.
		}
	}
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
		args.push(`--import-picture-from=3|${coverMimeOf(tags.cover)}|||${coverTmp}`);
	} else if (preserved) {
		const bytes = await readFile(preserved);
		args.push(`--import-picture-from=3|${coverMimeOf(bytes)}|||${preserved}`);
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
		if (preserved) await unlink(preserved).catch(() => undefined);
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
/**
 * The fields whose value in the file differs from the canonical DB row.
 *
 * This is the whole fix for "the database is right and the file is wrong". The
 * old rule — skip when the file already has a title and artist — meant a file
 * could hold every field wrong, or none at all, and still be skipped. It also
 * meant a field could never reach disk if it was recovered into the DB by any
 * route other than a metadata patch: album_artist arrived that way, the gap
 * rule then considered the row complete, no patch followed, and no re-tag ever
 * ran. 0 of 675 files carried ALBUMARTIST as a result.
 *
 * Pure, so the decision is testable without touching a filesystem. Compared as
 * NFC on both sides: the tag writer canonicalises, and comparing raw bytes would
 * re-flag every Zalgo title as a disagreement forever.
 */
export function tagsDisagree(
	tags: TagData,
	file: Record<string, unknown> | null,
	opts: { fileHasCover?: boolean } = {},
): string[] {
	// Missing artwork is a disagreement in its own right.
	//
	// Without this, a file whose TEXT tags are all correct but which carries no
	// picture is 'skipped' forever — and a repair then does nothing at all, which
	// is exactly what a non-force repair did: retagged 0, no art, and the album
	// stayed bare on Navidrome while 213 others had covers. The caller supplies the
	// bytes; we only compare presence, never the image data.
	if (tags.cover && opts.fileHasCover === false) {
		return ['cover', ...tagsDisagree(tags, file, { fileHasCover: true })];
	}
	if (!file)
		return [
			'title',
			'artist',
			'album',
			'albumArtist',
			'trackNumber',
			'discNumber',
			'year',
			'genre',
		];
	// `file` comes from music-metadata, whose tag values are `string | number[]`
	// for multi-valued frames — not `unknown`. Narrowing to string/number here
	// keeps a stray object out of String() rather than yielding '[object Object]',
	// which would silently compare as a permanent disagreement and re-tag the
	// whole library on every pass.
	const asText = (v: unknown): string | null => {
		if (v == null) return null;
		if (typeof v === 'string') return v === '' ? null : v;
		if (typeof v === 'number') return String(v);
		if (Array.isArray(v)) {
			const parts = v.filter((x): x is string => typeof x === 'string' && x !== '');
			return parts.length ? parts.join(' / ') : null;
		}
		return null;
	};
	// Non-canonical text in the FILE is a defect in its own right, independent of
	// what the database says. Comparing NFC on both sides — which is what stops a
	// zalgo title being re-tagged for ever — also hides it: a file holding the
	// marks in the wrong order normalises to the same string as the row, so the
	// two agree and nothing is ever rewritten. That is why #CUT4ZALGO stayed
	// broken after the writer was fixed: the writer only affects future writes.
	// The raw form is therefore compared as well, and the rewrite it triggers
	// settles the disagreement permanently.
	const nonCanonical = (v: unknown): boolean => {
		const text = asText(v);
		return text != null && text !== text.normalize('NFC');
	};
	const same = (a: string | number | null | undefined, b: unknown): boolean => {
		const left = a == null || a === '' ? null : String(a);
		const right = asText(b);
		if (left === null && right === null) return true;
		if (nonCanonical(b)) return false;
		if (left === right) return true;
		if (left === null || right === null) return false;
		return left.normalize('NFC') === right.normalize('NFC');
	};
	const out: string[] = [];
	if (!same(tags.title, file.title)) out.push('title');
	if (!same(tags.artist, file.artist)) out.push('artist');
	if (!same(tags.album, file.album)) out.push('album');
	if (!same(tags.albumArtist, file.albumartist)) out.push('albumArtist');
	const trackNo = (file.track as { no?: number } | undefined)?.no;
	if (tags.trackNumber != null && Number(trackNo ?? 0) !== tags.trackNumber) {
		out.push('trackNumber');
	}
	const discNo = (file.disk as { no?: number } | undefined)?.no;
	if (tags.discNumber != null && Number(discNo ?? 0) !== tags.discNumber) {
		out.push('discNumber');
	}
	if (tags.year != null && Number(file.year ?? 0) !== tags.year) out.push('year');
	if (!same(tags.genre, file.genre)) out.push('genre');
	// Identities are compared too, so a file that predates the MBID columns gets
	// them written on the next repair pass. Only compared when the ROW has one:
	// "the database does not know" is not a reason to retag every file in the
	// library on every pass.
	if (tags.artistMbid && !same(tags.artistMbid, file.musicbrainz_artistid))
		out.push('artistMbid');
	if (tags.albumArtistMbid && !same(tags.albumArtistMbid, file.musicbrainz_albumartistid))
		out.push('albumArtistMbid');
	if (tags.recordingMbid && !same(tags.recordingMbid, file.musicbrainz_recordingid))
		out.push('recordingMbid');
	if (tags.releaseTrackMbid && !same(tags.releaseTrackMbid, file.musicbrainz_trackid))
		out.push('releaseTrackMbid');
	if (tags.releaseMbid && !same(tags.releaseMbid, file.musicbrainz_albumid))
		out.push('releaseMbid');
	if (tags.releaseGroupMbid && !same(tags.releaseGroupMbid, file.musicbrainz_releasegroupid))
		out.push('releaseGroupMbid');
	return out;
}

export async function ensureFileTags(
	filePath: string,
	tags: TagData,
	opts: { force?: boolean } = {},
): Promise<'ok' | 'skipped' | 'failed'> {
	try {
		const ext: 'flac' | 'wav' | 'mp3' = filePath.toLowerCase().endsWith('.flac')
			? 'flac'
			: filePath.toLowerCase().endsWith('.wav')
				? 'wav'
				: 'mp3';
		const info = await parseFile(filePath, { duration: false, skipCovers: false }).catch(
			() => null,
		);
		const common = (info?.common ?? null) as Record<string, unknown> | null;

		// Carry forward whatever this pass was NOT asked to change.
		//
		// Both writers rebuild the tag block from scratch (`metaflac
		// --remove-all-tags`, `NodeID3.removeTags`) and then write only the fields they
		// were handed. A field that is null in the caller's TagData is therefore not
		// left alone — it is ERASED. Turning the repair path on for the first time in
		// 0.7.2 measured 651 of 675 files stripped of album, title, artist and date,
		// and 675 of 675 stripped of genre, because the gap rule leaves those null on
		// any row the metadata pass has not filled.
		//
		// The database is authoritative for the fields it HAS; its silence about a
		// field is not evidence the file's value should be blanked. Absent means
		// "not this pass's business", so the file's own value survives.
		const text = (v: unknown): string | null => {
			if (typeof v === 'string' && v !== '') return v;
			if (Array.isArray(v) && typeof v[0] === 'string' && v[0] !== '') return v[0];
			return null;
		};
		const num = (v: unknown): number | null =>
			typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : null;
		// Lyrics are re-derived from disk rather than carried from the file.
		//
		// Every caller that retags from the database (adoption, metadata repair,
		// the Navidrome repair pass) passes null for both lyrics fields, and the
		// writers rebuild the tag block from scratch — so each pass ERASED the
		// lyrics it was supposed to leave alone. That is why 1225 of 1309 files
		// carried no lyrics tag at all while the dashboard reported 822 tracks
		// with lyrics: the sidecar existed, the tag did not.
		//
		// The sidecar beside the file wins because it is what the fetch wrote and
		// it keeps its timestamps. Only when there is no sidecar do we fall back
		// to whatever tag the file already had, so a re-tag still loses nothing.
		const sidecar =
			tags.lyricsSynced || tags.lyricsPlain ? null : await readLyricsSidecar(filePath);
		const fileLyrics =
			(common?.lyrics as Array<{ text?: string }> | undefined)?.find((l) => l?.text)?.text ??
			null;
		const carried: TagData = {
			title: tags.title ?? text(common?.title) ?? 'Unknown Title',
			artist: tags.artist ?? text(common?.artist) ?? 'Unknown Artist',
			album: tags.album ?? text(common?.album),
			albumArtist: tags.albumArtist ?? text(common?.albumartist),
			genre: tags.genre ?? text(common?.genre),
			year: tags.year ?? num(common?.year),
			trackNumber:
				tags.trackNumber ?? num((common?.track as { no?: unknown } | undefined)?.no),
			discNumber: tags.discNumber ?? num((common?.disk as { no?: unknown } | undefined)?.no),
			// The writers wipe every block, picture included, before writing. Reading
			// the existing art back costs a tag parse we already did and prevents a
			// lyrics pass from stripping covers off every MP3 in the library.
			cover: tags.cover ?? embeddedPicture(common),
			lyricsSynced: tags.lyricsSynced ?? (sidecar?.synced ? sidecar.text : null),
			lyricsPlain:
				tags.lyricsPlain ?? (sidecar ? (sidecar.synced ? null : sidecar.text) : fileLyrics),
			// MBIDs are carried from the file for the same reason as every other
			// field here: both writers rebuild the tag block from scratch, so a
			// null in TagData ERASES the identity rather than leaving it alone.
			artistMbid: tags.artistMbid ?? text(common?.musicbrainz_artistid),
			albumArtistMbid: tags.albumArtistMbid ?? text(common?.musicbrainz_albumartistid),
			recordingMbid: tags.recordingMbid ?? text(common?.musicbrainz_recordingid),
			releaseTrackMbid: tags.releaseTrackMbid ?? text(common?.musicbrainz_trackid),
			releaseMbid: tags.releaseMbid ?? text(common?.musicbrainz_albumid),
			releaseGroupMbid: tags.releaseGroupMbid ?? text(common?.musicbrainz_releasegroupid),
		};

		let disagreeing: string[] = [];
		if (!opts.force) {
			// music-metadata parses covers into common.picture unless skipped.
			const pics = (common?.picture as unknown[] | undefined) ?? [];
			disagreeing = tagsDisagree(carried, common, { fileHasCover: pics.length > 0 });
			if (disagreeing.length === 0) return 'skipped';
		}
		if (ext === 'flac') await tagFlac(filePath, carried);
		else if (ext === 'mp3') tagMp3(filePath, carried);
		// WAV has no standard tag block these writers understand (metaflac is
		// FLAC-only, node-id3 is ID3/MP3), so a WAV is filed with whatever tags
		// it arrived with rather than being corrupted by the wrong writer.
		log.info('repaired embedded tags', {
			filePath,
			force: opts.force ?? false,
			...(disagreeing.length ? { disagreeing: disagreeing.join(',') } : {}),
		});
		return 'ok';
	} catch (err) {
		log.warn('tag repair failed', { filePath, error: String(err) });
		return 'failed';
	}
}

/**
 * Write lyrics into the audio file itself.
 *
 * This is the step that makes them visible in Navidrome: its web player reads
 * the `LYRICS` tag from its scanned row — never the `.lrc` sidecar — and renders
 * only entries flagged `synced`. Download and backfill both come through here so
 * there is exactly one definition of "the lyrics are in the file".
 */
export async function embedLyrics(
	filePath: string,
	tags: TagData,
	lyrics: { text: string; synced: boolean },
): Promise<'ok' | 'failed'> {
	const outcome = await ensureFileTags(
		filePath,
		{
			...tags,
			lyricsSynced: lyrics.synced ? lyrics.text : null,
			lyricsPlain: lyrics.synced ? null : lyrics.text,
		},
		{ force: true },
	);
	return outcome === 'ok' ? 'ok' : 'failed';
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
