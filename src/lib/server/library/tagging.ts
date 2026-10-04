import * as NodeID3 from 'node-id3';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { Processor, data as flacData } from 'flac-metadata';
import type { MetaDataBlockVorbisComment } from 'flac-metadata';
import { parseFile } from 'music-metadata';
import { logger } from '$lib/server/logger';

const log = logger;

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

/** Tag an MP3 in place (ID3v2.4, TCON genre, USLT unsynced lyrics, APIC art). */
export function tagMp3(path: string, tags: TagData): void {
	const frames: Record<string, unknown> = {
		title: tags.title,
		artist: tags.artist,
		album: tags.album ?? undefined,
		performerInfo: tags.albumArtist ?? undefined,
		trackNumber: tags.trackNumber != null ? String(tags.trackNumber) : undefined,
		partOfSet: tags.discNumber != null ? String(tags.discNumber) : undefined,
		year: tags.year != null ? String(tags.year) : undefined,
		genre: tags.genre ?? undefined,
		unsynchronisedLyrics: tags.lyricsPlain
			? { language: 'eng', text: tags.lyricsPlain }
			: undefined,
	};
	if (tags.cover) {
		frames.image = {
			mime: 'image/jpeg',
			type: 3,
			description: 'Cover',
			imageBuffer: tags.cover,
		};
	}
	NodeID3.removeTags(path);
	const written = NodeID3.write(frames, path);
	if (written instanceof Error) throw written;
}

/**
 * Rewrite Vorbis comments for FLAC via the flac-metadata stream processor.
 * The processor re-emits each metadata block; we mutate the VORBIS_COMMENT
 * block in place. Cover art is intentionally NOT embedded in FLAC — it is
 * stored as `cover.jpg` beside the album (Navidrome reads folder art); MP3s
 * get an embedded APIC instead.
 */
export async function tagFlac(path: string, tags: TagData): Promise<void> {
	const comments: string[] = [`TITLE=${tags.title}`, `ARTIST=${tags.artist}`];
	if (tags.album) comments.push(`ALBUM=${tags.album}`);
	if (tags.albumArtist) comments.push(`ALBUMARTIST=${tags.albumArtist}`);
	if (tags.trackNumber != null) comments.push(`TRACKNUMBER=${String(tags.trackNumber)}`);
	if (tags.discNumber != null) comments.push(`DISCNUMBER=${String(tags.discNumber)}`);
	if (tags.year != null) comments.push(`DATE=${String(tags.year)}`);
	if (tags.genre) comments.push(`GENRE=${tags.genre}`);
	if (tags.lyricsPlain) comments.push(`LYRICS=${tags.lyricsPlain.replace(/\r/g, '')}`);

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
		// Store files without a VORBIS_COMMENT block: audio stays valid, tags
		// live in the DB and the sidecar files. Phase 2 can add block injection.
		log.warn('flac had no vorbis-comment block; embedded tags skipped', { path });
	}
	void flacData; // namespace re-exported for future picture embedding
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
