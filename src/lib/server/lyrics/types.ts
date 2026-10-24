import type { TrackMeta } from '$lib/server/providers/types';

/**
 * Lyrics source contract. Sources are traversed in priority order (see
 * lyrics/index.ts); a synced result wins immediately, otherwise the first plain
 * result is kept while the remaining sources are still asked for a synced copy.
 * Reference: shub39/echo-lrclib-extension (LRCLIB usage) and
 * LuftVerbot/echo-deezer-extension (Deezer pipe synced lyrics).
 */

export interface LyricsQuery {
	title: string;
	artist: string;
	album?: string | null;
	/** Duration in seconds — improves LRCLIB match precision. */
	durationSec?: number | null;
	/**
	 * Recording ISRC. This is the only key that identifies the exact recording
	 * rather than "a song with this title by this artist", so it is what
	 * lrc.red and Apple use to avoid live/remix/cover mismatches.
	 */
	isrc?: string | null;
	/** Deezer track id for the deezer-pipe source. */
	providerTrackId?: string | null;
}

export interface LyricsResult {
	synced: string | null;
	plain: string | null;
	/**
	 * Only an exact lookup may set this. It means "this recording has no lyrics
	 * by design", so the track must not be retried — an instrumental will never
	 * produce a lyric no matter how often the sweep asks.
	 */
	instrumental?: boolean;
	/**
	 * True when the timings/words were machine-generated from the audio (ASR)
	 * rather than sourced from a published lyric. Usable when nothing better
	 * exists, but it must not shadow an official synced copy from another source.
	 */
	generated?: boolean;
}

export interface LyricsSource {
	id: string;
	/** Human-friendly name for logs. */
	displayName: string;
	fetch(q: LyricsQuery, meta?: TrackMeta): Promise<LyricsResult | null>;
}
