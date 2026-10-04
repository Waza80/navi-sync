import { parseFile } from 'music-metadata';
import { logger } from '$lib/server/logger';
import type { MetadataPatch } from './types';

/**
 * The file's own embedded tags — the FIRST fallback for missing metadata.
 *
 * A FLAC straight off a store rip usually carries its own album, album artist,
 * genre, year, track/disc number and ISRC. Reading them is free, instant and
 * authoritative for *that exact file*, so it beats any external lookup. Only
 * fields the caller reports as missing are returned.
 */

const log = logger;

const asText = (v: unknown): string | null => {
	if (typeof v === 'string' && v.trim() !== '') return v;
	if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim() !== '') return v[0];
	return null;
};

const asYear = (v: unknown): number | null => {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	const text = asText(v);
	if (!text) return null;
	const m = /(\d{4})/.exec(text);
	if (!m?.[1]) return null;
	const y = Number.parseInt(m[1], 10);
	return Number.isFinite(y) ? y : null;
};

const asIndex = (v: unknown): number | null => {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	const text = asText(v);
	if (!text) return null;
	const n = Number.parseInt(text, 10);
	return Number.isFinite(n) ? n : null;
};

/**
 * Reads the file's embedded tags and returns ONLY the requested fields that
 * are actually present. Returns null when the file can't be parsed.
 */
export async function readFileTags(
	filePath: string,
	needed: Array<
		'album' | 'albumArtist' | 'genre' | 'year' | 'trackNumber' | 'discNumber' | 'isrc'
	>,
): Promise<MetadataPatch | null> {
	try {
		const info = await parseFile(filePath, { duration: false });
		const common = info.common;
		if (!common) return null;
		const patch: MetadataPatch = {};
		const wanted = new Set(needed);
		if (wanted.has('album')) {
			const v = asText(common.album);
			if (v) patch.album = v;
		}
		if (wanted.has('albumArtist')) {
			const v = asText(common.albumartist);
			if (v) patch.albumArtist = v;
		}
		if (wanted.has('genre')) {
			const v = asText(common.genre?.[0]);
			if (v) patch.genre = v;
		}
		if (wanted.has('year')) {
			const v = asYear(common.year);
			if (v !== null) patch.year = v;
		}
		if (wanted.has('trackNumber')) {
			const v = asIndex(common.track.no);
			if (v !== null) patch.trackNumber = v;
		}
		if (wanted.has('discNumber')) {
			const v = asIndex(common.disk.no);
			if (v !== null) patch.discNumber = v;
		}
		if (wanted.has('isrc')) {
			const v = asText(common.isrc?.[0]);
			if (v) patch.isrc = v;
		}
		return Object.keys(patch).length > 0 ? patch : null;
	} catch (err) {
		log.debug('file tag read failed', { filePath, error: String(err) });
		return null;
	}
}
