import { readFile } from 'node:fs/promises';

/**
 * Where a lyrics sidecar lives, and what is in it.
 *
 * The one rule: a sidecar sits NEXT TO ITS AUDIO FILE.
 *
 * It used to be derived from the track's metadata (`<artist>/<album>/<NN - title>`)
 * instead — recomputing the library path from tags. Any disagreement between the
 * row's `artist` and the folder it was actually filed under (a merged credit
 * list, a later album rename) then wrote the sidecar into a directory the audio
 * never lived in. Navidrome only looks beside the file, so those were invisible
 * no matter how good their contents were. `remotePath` and the real path must
 * come from the same place: the file.
 */

/** Audio extensions we file (and therefore strip to find a sidecar). */
const AUDIO_EXT = /\.(flac|mp3|m4a|opus|ogg|wav|aiff?)$/i;

export function sidecarBase(audioPath: string): string {
	return audioPath.replace(AUDIO_EXT, '');
}

export interface LyricsOnDisk {
	/** The sidecar's contents. */
	text: string;
	/** True for `.lrc` (timestamps), false for `.txt`. */
	synced: boolean;
	/** Absolute path of the sidecar that was read. */
	path: string;
}

/**
 * Read the best sidecar beside a file: `.lrc` (synced) before `.txt` (plain).
 *
 * An empty file is treated as absent — a zero-byte `.lrc` is a failed write, not
 * a lyric, and reporting it as synced would stop the next fetch from trying.
 */
export async function readLyricsSidecar(audioPath: string): Promise<LyricsOnDisk | null> {
	const base = sidecarBase(audioPath);
	for (const [ext, synced] of [
		['.lrc', true],
		['.txt', false],
	] as const) {
		const path = `${base}${ext}`;
		try {
			const text = await readFile(path, 'utf8');
			if (text.trim().length > 0) return { text, synced, path };
		} catch {
			// Absent is the normal case, not an error.
		}
	}
	return null;
}
