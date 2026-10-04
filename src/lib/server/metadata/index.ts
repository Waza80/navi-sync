import { readFileTags } from './filetags';
import { logger } from '$lib/server/logger';
import type { MetadataPatch, MetadataQuery, MetadataSource } from './types';
import { cleanPatch, patchKeys } from './types';
import { itunesSource } from './sources/itunes';
import { musicbrainzSource } from './sources/musicbrainz';

/**
 * Metadata enrichment — a strict, ordered fallback chain.
 *
 *   0. the FILE's own embedded tags  (free, authoritative for that exact file)
 *   1. MusicBrainz                   (open catalog; album/year/cover via ISRC)
 *   2. Apple Music                   (cover art ONLY)
 *
 * The external sources are strictly a BACKUP: they are consulted only for the
 * fields that are still missing after the file's own tags have been read, and a
 * source that cannot answer with high confidence returns nothing rather than
 * guessing. A wrong album would rewrite the file's folder, so leaving a field
 * empty is always the safer outcome.
 */

const log = logger;

export const metadataSources: MetadataSource[] = [musicbrainzSource, itunesSource];

export interface EnrichResult {
	patch: MetadataPatch;
	/** Which source supplied each newly-filled field ('file' or a source id). */
	filledBy: Record<string, string>;
	/** Fallbacks that were tried, in order. */
	tried: string[];
}

/**
 * Fills the row's metadata gaps: file tags first, then each catalog source.
 * Never throws — a broken source is skipped.
 */
export async function enrichTrackMetadata(query: MetadataQuery): Promise<EnrichResult> {
	const remaining = new Set(query.needed);
	const merged: MetadataPatch = {};
	const filledBy: Record<string, string> = {};
	const tried: string[] = [];

	const absorb = (patch: MetadataPatch, source: string): void => {
		for (const key of patchKeys(patch)) {
			if (!remaining.has(key)) continue;
			// Assign through a narrowed view so TS keeps the union type.
			Object.assign(merged, { [key]: (patch as Record<string, unknown>)[key] });
			filledBy[key] = source;
			remaining.delete(key);
		}
	};

	// ── 0. The file's own tags ───────────────────────────────────────────────
	if (query.filePath && remaining.size > 0) {
		tried.push('file');
		const tagFields = [...remaining].filter(
			(
				f,
			): f is
				| 'album'
				| 'albumArtist'
				| 'genre'
				| 'year'
				| 'trackNumber'
				| 'discNumber'
				| 'isrc' => f !== 'coverUrl',
		);
		if (tagFields.length > 0) {
			const fromFile = await readFileTags(query.filePath, tagFields)
				.then((p) => (p ? cleanPatch(p) : null))
				.catch(() => null);
			if (fromFile) {
				absorb(fromFile, 'file');
				log.info('metadata recovered from file tags', {
					trackId: query.trackId,
					fields: patchKeys(fromFile).join(','),
				});
			}
		}
	}

	// ── 1..n. Catalog sources ────────────────────────────────────────────────
	for (const source of metadataSources) {
		if (remaining.size === 0) break;
		tried.push(source.id);
		const patch = await source
			.lookup({ ...query, needed: [...remaining] })
			.then((p) => (p ? cleanPatch(p) : null))
			.catch((err) => {
				log.debug('metadata source failed', { source: source.id, error: String(err) });
				return null;
			});
		if (!patch) continue;
		absorb(patch, source.id);
	}

	return { patch: merged, filledBy, tried };
}

export type { MetadataPatch, MetadataQuery, MetadataSource, MetadataField } from './types';
export { cleanPatch, neededFieldsFor, patchKeys } from './types';
