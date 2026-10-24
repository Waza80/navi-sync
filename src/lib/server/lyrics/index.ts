import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { trackBaseRelativePath } from '$lib/server/library/paths';
import { logger } from '$lib/server/logger';
import { env } from '$lib/server/env';
import { readLyricsSidecar, sidecarBase } from './sidecar';
import { lrcRedSource } from './lrcred';
import { lrclibSource } from './lrclib';
import { deezerPipeSource } from './deezer-pipe';
import { deezerSearchSource } from './deezer-search';
import { appleMusicSource } from './apple-music';
import type { LyricsQuery, LyricsSource } from './types';
import type { TrackMeta } from '$lib/server/providers/types';

/**
 * Lyrics manager — priority-based source traversal with graceful fallback.
 *
 * Contract (spec): downloadLyrics() returns { success, path?, error? }.
 * Sources are tried in order and the FIRST SYNCED result wins. A plain result
 * does not end the traversal: it is kept as the fallback while the remaining
 * sources are asked for a synced copy. That distinction is the whole ballgame —
 * LRCLIB answered plain for 79 of 97 "plain" tracks, and the old early return
 * meant 27 Deezer-synced and 8 Apple-synced copies were never even queried.
 *
 * When ALL sources fail we fail loudly (WARN log for manual review) but the
 * error is contained — a missing lyric never blocks the audio file.
 */

const log = logger;

/**
 * Order is by match certainty first, then speed:
 *  1. lrc.red     — ISRC lookup (no fuzzy match possible), ~60 ms
 *  2. LRCLIB      — artist+title+album+duration, ~100 ms
 *  3. Deezer pipe — exact SNG_ID, ~400 ms
 *  4. Deezer search — strict metadata match, ~1 s
 *  5. Apple/Pax   — ISRC or strict search; Pax is slow and frequently 502s
 */
export const lyricsSources: LyricsSource[] = [
	lrcRedSource,
	lrclibSource,
	deezerPipeSource,
	deezerSearchSource,
	appleMusicSource,
];

export interface DownloadLyricsResult {
	success: boolean;
	path?: string;
	synced?: boolean;
	/** Source that produced the winning copy. Recorded on the track row. */
	source?: string;
	/** True when the synced copy is machine-generated (ASR), not published lyrics. */
	generated?: boolean;
	/** No lyrics exist by design (instrumental), so retries are pointless. */
	instrumental?: boolean;
	error?: string;
}

export interface ExistingSidecar {
	kind: 'synced' | 'plain';
	path: string;
}

/**
 * Lyrics gating helper: returns the sidecar already on disk for this song,
 * if any. Fetch policy everywhere in the app: hit the lyrics APIs ONLY when
 * the song misses lyrics (no sidecar) or was just upgraded. An optional root
 * keeps unit tests off the real library.
 */
/**
 * Strip `[mm:ss.xx]` timestamps from LRC text to get the plain lyrics.
 *
 * Players want BOTH forms: the timestamped text for synchronised display, and
 * the bare words for search, karaoke-less players and anything that does not
 * understand LRC. Exported so the embed step derives one from the other rather
 * than re-fetching.
 */
export function stripLrcTimestamps(lrc: string): string {
	return (
		lrc
			.split(/\r?\n/)
			// Keep metadata lines out of the plain lyrics ([ar:], [ti:], [length:]…).
			.filter((line) => !/^\[[a-z]+:/i.test(line.trim()))
			.map((line) => line.replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, ''))
			.filter((line) => line.trim().length > 0)
			.join('\n')
	);
}

export async function lyricsSidecar(
	meta: TrackMeta,
	root: string = env.MUSIC_LIBRARY_DIR,
): Promise<ExistingSidecar | null> {
	// Only used before a file exists (the download handler, pre-move). Once the
	// audio is on disk, call `readLyricsSidecar(filePath)` instead: the sidecar
	// must be looked up beside the file, not recomputed from its tags.
	const found = await readLyricsSidecar(join(root, trackBaseRelativePath(meta)));
	return found ? { kind: found.synced ? 'synced' : 'plain', path: found.path } : null;
}

export async function downloadLyrics(
	meta: TrackMeta,
	/**
	 * Absolute path of the audio file these lyrics belong to.
	 *
	 * When supplied, the sidecar is written next to THAT file. Without it the
	 * path is rebuilt from the track's tags, which can disagree with where the
	 * file was actually filed (a merged artist credit, a renamed album) and puts
	 * the sidecar somewhere Navidrome never looks.
	 */
	audioPath?: string,
	/** Injectable for tests; production always uses the ordered registry. */
	sources: LyricsSource[] = lyricsSources,
): Promise<DownloadLyricsResult> {
	const query: LyricsQuery = {
		title: meta.title,
		artist: meta.artist,
		album: meta.album,
		durationSec: meta.durationSec,
		isrc: meta.isrc,
		providerTrackId: meta.provider === 'deezer' ? meta.providerTrackId : null,
	};

	const failures: string[] = [];
	let plainFallback: { text: string; source: string } | null = null;
	let generatedFallback: { text: string; source: string } | null = null;
	let instrumental = false;

	for (const source of sources) {
		try {
			const result = await source.fetch(query, meta);
			if (!result) {
				failures.push(`${source.id}: no match`);
				continue;
			}
			if (result.synced) {
				// Machine-generated timings are a last resort: keep them, but let an
				// official synced copy from a later source win instead.
				if (result.generated) {
					generatedFallback ??= { text: result.synced, source: source.id };
					continue;
				}
				const path = await writeSidecar(meta, `${result.synced}\n`, 'lrc', audioPath);
				// A synced copy supersedes a plain one. Leaving both beside the file
				// makes "which sidecar is canonical" depend on read order.
				await unlink(path.replace(/\.lrc$/, '.txt')).catch(() => {});
				log.info('lyrics fetched (synced)', { source: source.id, path });
				return { success: true, path, synced: true, source: source.id };
			}
			if (result.plain) {
				// Keep looking: a later source may have the same words WITH timing.
				plainFallback ??= { text: result.plain, source: source.id };
				continue;
			}
			if (result.instrumental) instrumental = true;
			failures.push(`${source.id}: empty content`);
		} catch (err) {
			failures.push(`${source.id}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Nothing official came back. A synced copy already on disk still beats every
	// fallback below — an upgrade re-embeds whatever this returns, so writing a
	// generated or plain version here would silently downgrade the tag.
	const existing = audioPath ? await readLyricsSidecar(audioPath) : null;
	if (existing?.synced) {
		log.info('kept existing synced sidecar', { path: existing.path });
		return { success: true, path: existing.path, synced: true };
	}

	if (generatedFallback) {
		const path = await writeSidecar(meta, `${generatedFallback.text}\n`, 'lrc', audioPath);
		await unlink(path.replace(/\.lrc$/, '.txt')).catch(() => {});
		log.info('lyrics fetched (machine-generated, no official synced source)', {
			source: generatedFallback.source,
			path,
		});
		return {
			success: true,
			path,
			synced: true,
			generated: true,
			source: generatedFallback.source,
		};
	}

	if (plainFallback) {
		const path = await writeSidecar(meta, `${plainFallback.text}\n`, 'txt', audioPath);
		log.info('lyrics fetched (plain, no synced source)', {
			source: plainFallback.source,
			path,
		});
		return { success: true, path, synced: false, source: plainFallback.source };
	}

	// Every source failed. A sidecar that is already on disk is still better than
	// losing the tag on the next re-embed (an upgrade replaces the audio file, so
	// "no result" would mean the new file ships with no lyrics at all).
	if (existing) {
		log.info('all sources failed — kept existing sidecar', { path: existing.path });
		return { success: true, path: existing.path, synced: existing.synced };
	}

	if (instrumental) {
		log.info('track is instrumental — no lyrics exist', {
			title: meta.title,
			artist: meta.artist,
		});
		return { success: false, instrumental: true, error: 'instrumental' };
	}

	// Spec: fail loudly, log for manual review.
	log.warn('ALL LYRICS SOURCES FAILED — manual review recommended', {
		title: meta.title,
		artist: meta.artist,
		providerTrackId: meta.providerTrackId,
		failures,
	});
	return { success: false, error: failures.join('; ') };
}

async function writeSidecar(
	meta: TrackMeta,
	content: string,
	ext: 'lrc' | 'txt',
	audioPath?: string,
): Promise<string> {
	const base = audioPath
		? sidecarBase(audioPath)
		: join(env.MUSIC_LIBRARY_DIR, trackBaseRelativePath(meta));
	const absPath = `${base}.${ext}`;
	await mkdir(dirname(absPath), { recursive: true });
	await writeFile(absPath, content, 'utf8');
	return absPath;
}

export type { LyricsQuery, LyricsSource } from './types';
export { lyricsFilePath } from '$lib/server/library/paths';
