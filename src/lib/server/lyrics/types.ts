import type { TrackMeta } from '$lib/server/providers/types';

/**
 * Lyrics source contract. Sources are traversed in priority order (see
 * lyrics/index.ts); the first source returning usable content wins.
 * Reference: shub39/echo-lrclib-extension (LRCLIB usage) and
 * LuftVerbot/echo-deezer-extension (Deezer pipe synced lyrics).
 */

export interface LyricsQuery {
	title: string;
	artist: string;
	album?: string | null;
	/** Duration in seconds — improves LRCLIB match precision. */
	durationSec?: number | null;
	/** Deezer track id for the deezer-pipe source. */
	providerTrackId?: string | null;
}

export interface LyricsResult {
	synced: string | null;
	plain: string | null;
}

export interface LyricsSource {
	id: string;
	/** Human-friendly name for logs. */
	displayName: string;
	fetch(q: LyricsQuery, meta?: TrackMeta): Promise<LyricsResult | null>;
}
