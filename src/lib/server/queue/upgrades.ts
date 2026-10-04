import { and, eq, gte, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { jobs } from '$lib/server/db/schema';
import { getSettings } from '$lib/server/settings';
import { logger } from '$lib/server/logger';
import { enabledProviders } from '$lib/server/providers/enabled';
import type { QualityPreferences, StreamResolution, TrackMeta } from '$lib/server/providers/types';
import { qualityRank } from '$lib/shared/quality';

/**
 * Cross-provider best-quality engine.
 *
 * For a track below the 24-bit ceiling, ask EVERY configured provider for the
 * best available stream (ISRC-exact when possible), then pick the highest
 * rank. "If only one is up, it takes precedence; if both work, the best
 * quality always wins." The sweep keeps iterating until everything is 24-bit.
 */

const log = logger;

export interface UpgradeCandidate {
	provider: string;
	meta: TrackMeta;
	resolution: StreamResolution;
	incomingRank: number;
}

export interface TrackForUpgrade {
	id: string;
	provider: string;
	providerTrackId: string | null;
	title: string;
	artist: string;
	album: string | null;
	isrc: string | null;
	sourceUrl: string | null;
	durationSec: number | null;
	year: number | null;
	genre: string | null;
	format: string;
	bitrateKbps: number | null;
	bitDepth: number | null;
	isLossless: boolean;
}

function prefsOf(settings: {
	preferLossless: boolean;
	minBitrateKbps: number;
	allowLowerFallback: boolean;
}): QualityPreferences {
	return {
		preferLossless: settings.preferLossless,
		minBitrateKbps: settings.minBitrateKbps,
		allowLowerFallback: settings.allowLowerFallback
	};
}

async function hasRecentUpgradeAttempt(trackId: string, hours: number): Promise<boolean> {
	const rows = await db
		.select({ id: jobs.id })
		.from(jobs)
		.where(
			and(
				eq(jobs.trackId, trackId),
				inArray(jobs.type, ['download', 'upgrade_check']),
				gte(jobs.createdAt, new Date(Date.now() - hours * 3600 * 1000))
			)
		)
		.limit(1);
	return rows.length > 0;
}

/**
 * Finds the best strictly-better offer across all configured providers.
 * Returns null when the track is already at its best available quality.
 */
export async function findBestUpgrade(
	track: TrackForUpgrade,
	opts: { skipRecentCheck?: boolean } = {}
): Promise<UpgradeCandidate | null> {
	const settings = await getSettings();
	const existingRank = qualityRank({
		format: track.format,
		bitrateKbps: track.bitrateKbps,
		bitDepth: track.bitDepth,
		isLossless: track.isLossless
	});
	if (existingRank >= 4) return null; // 24-bit ceiling reached
	if (!opts.skipRecentCheck && (await hasRecentUpgradeAttempt(track.id, 24))) return null;

	const baseMeta: TrackMeta = {
		provider: track.provider,
		providerTrackId: track.providerTrackId ?? '',
		title: track.title,
		artist: track.artist,
		album: track.album,
		albumArtist: track.artist,
		isrc: track.isrc,
		trackNumber: null,
		discNumber: null,
		durationSec: track.durationSec,
		year: track.year,
		genre: track.genre,
		coverUrl: null,
		sourceUrl: track.sourceUrl,
		streamToken: null
	};
	const prefs = prefsOf(settings);

	const candidates: UpgradeCandidate[] = [];
	const enabled = await enabledProviders();
	for (const provider of enabled) {
		try {
			let meta: TrackMeta = baseMeta;
			// Cross-provider: locate the same recording — ISRC first (exact),
			// then a STRICT title/artist/duration match (never guess).
			if (provider.id !== track.provider) {
				let found: TrackMeta | null = null;
				if (track.isrc && provider.findByIsrc) {
					const byIsrc = await provider.findByIsrc(track.isrc);
					if (byIsrc) found = byIsrc;
				}
				if (!found && provider.search) {
					const metas = await provider.search(`${track.artist} ${track.title}`).catch(() => []);
					const { findBestMatch } = await import('$lib/server/search/matcher');
					const verdict = findBestMatch(
						{
							title: track.title,
							artist: track.artist,
							album: track.album,
							durationSec: track.durationSec
						},
						metas.map((m) => ({
							title: m.title,
							artist: m.artist,
							album: m.album,
							durationSec: m.durationSec
						}))
					);
					if (verdict.candidate) {
						found =
							metas.find(
								(m) => m.title === verdict.candidate?.title && m.artist === verdict.candidate?.artist
							) ?? null;
					}
				}
				if (!found) continue;
				meta = found;
			}
			const resolution = await provider.resolve(meta, prefs);
			const incomingRank = qualityRank({
				format: resolution.format,
				bitrateKbps: resolution.claimedBitrateKbps,
				bitDepth: resolution.claimedBitDepth ?? null,
				isLossless: resolution.claimedLossless
			});
			if (incomingRank > existingRank) {
				candidates.push({ provider: provider.id, meta, resolution, incomingRank });
			}
		} catch (err) {
			log.debug('upgrade candidate unavailable', {
				provider: provider.id,
				trackId: track.id,
				error: String(err)
			});
		}
	}

	if (candidates.length === 0) return null;
	candidates.sort((a, b) => b.incomingRank - a.incomingRank);
	const best = candidates[0];
	if (!best) return null;
	return { ...best, incomingRank: best.incomingRank };
}
