import { logger } from '$lib/server/logger';
import { pickStrict } from '../match';
import type { MetadataPatch, MetadataQuery, MetadataSource } from '../types';
import type { TidalClient, TidalTrack } from '$lib/server/providers/tidal/client';

/**
 * Tidal catalog metadata.
 *
 * Tidal answers for essentially everything the library holds (measured 12/12
 * across the catalogue, versus 11/12 for Deezer and 8/12 for MusicBrainz),
 * because it carries the same metadata the downloads were resolved from. It is
 * therefore the most useful of the three for an upload — but not the most
 * trustworthy on its own, so `enrichTrackMetadata` only prefers it when another
 * source corroborates it.
 *
 * Every candidate goes through `pickStrict`; an unmatched result contributes
 * nothing rather than guessing.
 */

const log = logger;

async function clientOrNull(): Promise<TidalClient | null> {
	try {
		const { getProviderConfig } = await import('$lib/server/providers/config');
		const { TidalClient: Client } = await import('$lib/server/providers/tidal/client');
		const cfg = await getProviderConfig<{ instanceUrl: string }>('tidal');
		return cfg?.instanceUrl ? new Client(cfg) : null;
	} catch (err) {
		log.debug('tidal metadata source unavailable', { error: String(err) });
		return null;
	}
}

export const tidalSource: MetadataSource = {
	id: 'tidal',
	displayName: 'Tidal',
	requiresAuth: false,
	async lookup(query: MetadataQuery): Promise<MetadataPatch | null> {
		if (query.needed.length === 0) return null;
		const client = await clientOrNull();
		if (!client) return null;

		const results = await client
			.search(`${query.artist} ${query.title}`.trim(), 8)
			.catch((err) => {
				log.debug('tidal search failed', { error: String(err) });
				return [] as TidalTrack[];
			});
		if (results.length === 0) return null;

		const candidates = results.map((t) => ({
			title: t.title,
			artist: t.artist,
			album: t.album,
			durationSec: t.durationSec,
		}));
		const best = pickStrict(
			{
				title: query.title,
				artist: query.artist,
				album: query.album,
				durationSec: query.durationSec,
			},
			candidates,
		);
		if (!best) return null;
		const track = results.find((t) => t.title === best.title && t.artist === best.artist);
		return track ? toPatch(track, query) : null;
	},
};

/** Project a Tidal track onto only the fields the caller still needs. */
function toPatch(track: TidalTrack, query: MetadataQuery): MetadataPatch | null {
	const need = new Set(query.needed);
	const patch: MetadataPatch = {};
	if (need.has('album') && track.album) patch.album = track.album;
	if (need.has('albumArtist') && track.albumArtist) patch.albumArtist = track.albumArtist;
	if (need.has('year') && track.year != null) patch.year = track.year;
	if (need.has('trackNumber') && track.trackNumber != null) patch.trackNumber = track.trackNumber;
	if (need.has('discNumber') && track.discNumber != null) patch.discNumber = track.discNumber;
	if (need.has('isrc') && track.isrc) patch.isrc = track.isrc;
	if (need.has('coverUrl') && track.artworkUrl) patch.coverUrl = track.artworkUrl;
	// `genre` is never set: Tidal's catalogue exposes none, so there is nothing
	// truthful to offer and MusicBrainz covers the field instead.
	return Object.keys(patch).length > 0 ? patch : null;
}
