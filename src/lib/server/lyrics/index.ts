import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { trackBaseRelativePath } from '$lib/server/library/paths';
import { logger } from '$lib/server/logger';
import { env } from '$lib/server/env';
import { lrclibSource } from './lrclib';
import { appleMusicSource } from './apple-music';
import { deezerPipeSource } from './deezer-pipe';
import type { LyricsQuery, LyricsSource } from './types';
import type { TrackMeta } from '$lib/server/providers/types';

/**
 * Lyrics manager — priority-based source traversal with graceful fallback.
 *
 * Contract (spec): downloadLyrics() returns { success, path?, error? }.
 * Sources are tried in order; first usable result wins (synced preferred).
 * When ALL sources fail we fail loudly (WARN log for manual review) but the
 * error is contained — a missing lyric never blocks the audio file.
 */

const log = logger;

export const lyricsSources: LyricsSource[] = [lrclibSource, appleMusicSource, deezerPipeSource];

export interface DownloadLyricsResult {
	success: boolean;
	path?: string;
	synced?: boolean;
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
export async function lyricsSidecar(
	meta: TrackMeta,
	root: string = env.MUSIC_LIBRARY_DIR,
): Promise<ExistingSidecar | null> {
	const base = join(root, trackBaseRelativePath(meta));
	const lrc = `${base}.lrc`;
	if (
		await stat(lrc).then(
			() => true,
			() => false,
		)
	) {
		return { kind: 'synced', path: lrc };
	}
	const txt = `${base}.txt`;
	if (
		await stat(txt).then(
			() => true,
			() => false,
		)
	) {
		return { kind: 'plain', path: txt };
	}
	return null;
}

export async function downloadLyrics(meta: TrackMeta): Promise<DownloadLyricsResult> {
	const query: LyricsQuery = {
		title: meta.title,
		artist: meta.artist,
		album: meta.album,
		durationSec: meta.durationSec,
		providerTrackId: meta.provider === 'deezer' ? meta.providerTrackId : null,
	};

	const failures: string[] = [];
	for (const source of lyricsSources) {
		try {
			const result = await source.fetch(query, meta);
			if (!result) {
				failures.push(`${source.id}: no match`);
				continue;
			}
			if (result.synced) {
				const path = await writeSidecar(meta, `${result.synced}\n`, 'lrc');
				log.info('lyrics fetched (synced)', { source: source.id, path });
				return { success: true, path, synced: true };
			}
			if (result.plain) {
				const path = await writeSidecar(meta, `${result.plain}\n`, 'txt');
				log.info('lyrics fetched (plain)', { source: source.id, path });
				return { success: true, path, synced: false };
			}
			failures.push(`${source.id}: empty content`);
		} catch (err) {
			failures.push(`${source.id}: ${err instanceof Error ? err.message : String(err)}`);
		}
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

async function writeSidecar(meta: TrackMeta, content: string, ext: 'lrc' | 'txt'): Promise<string> {
	const absPath = join(env.MUSIC_LIBRARY_DIR, `${trackBaseRelativePath(meta)}.${ext}`);
	await mkdir(dirname(absPath), { recursive: true });
	await writeFile(absPath, content, 'utf8');
	return absPath;
}

export type { LyricsQuery, LyricsSource } from './types';
export { lyricsFilePath } from '$lib/server/library/paths';
