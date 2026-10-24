import { and, eq, gte, inArray } from 'drizzle-orm';
import { access } from 'node:fs/promises';
import { db } from '$lib/server/db';
import { jobs } from '$lib/server/db/schema';
import { getSettings } from '$lib/server/settings';
import { logger } from '$lib/server/logger';
import { enabledProviders } from '$lib/server/providers/enabled';
import type { QualityPreferences, StreamResolution, TrackMeta } from '$lib/server/providers/types';
import { isAtCeiling, qualityRank } from '$lib/shared/quality';

/**
 * Cross-provider best-quality engine.
 *
 * For a track below the top tier, ask EVERY configured provider for the best
 * available stream (ISRC-exact when possible), then pick the highest rank.
 * "If only one is up, it takes precedence; if both work, the best quality always
 * wins."
 *
 * The tiers are finer than they used to be. Deezer now serves a hi-res tier
 * (`FLAC_24`, verified 24-bit/96 kHz) alongside Tidal's 24/192, so "24-bit" is
 * no longer the end of the road and the sweep keeps iterating until a track is
 * at 24/192 — or until no provider has anything better, in which case the row's
 * `upgrade_checked_at` is stamped and the sweep moves on to the next track.
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
	/** Measured sample rate — the tier separator (24/44.1 vs 24/96 vs 24/192). */
	sampleRateHz: number | null;
	isLossless: boolean;
	/**
	 * Where the audio actually is, when the caller knows. A row can carry quality
	 * fields and still have no file (a failed upgrade nulls nothing; a moved
	 * library leaves a stale path), and treating those stored numbers as a real
	 * copy is how a file-less Deezer row was refused a perfectly good Tidal
	 * offer: it still "ranked" 16-bit FLAC and nothing lower could beat it.
	 */
	filePath?: string | null;
}

function prefsOf(settings: {
	preferLossless: boolean;
	minBitrateKbps: number;
	allowLowerFallback: boolean;
	preferHiRes?: boolean;
}): QualityPreferences {
	return {
		preferLossless: settings.preferLossless,
		minBitrateKbps: settings.minBitrateKbps,
		allowLowerFallback: settings.allowLowerFallback,
		preferHiRes: settings.preferHiRes ?? true,
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
				gte(jobs.createdAt, new Date(Date.now() - hours * 3600 * 1000)),
			),
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
	opts: { skipRecentCheck?: boolean } = {},
): Promise<UpgradeCandidate | null> {
	const settings = await getSettings();
	// Whether there is audio to protect, not whether the row claims quality.
	// A failed row keeps its old measured numbers, so `isAtCeiling` could refuse
	// a fresh download for a track that has no file at all — the exact case the
	// retry path exists to fix. Rank -1 means "anything fetched is an upgrade",
	// including an MP3 from a provider the stored FLAC-quality fields would have
	// outranked.
	const hasFile =
		typeof track.filePath === 'string' &&
		track.filePath.length > 0 &&
		(await access(track.filePath).then(
			() => true,
			() => false,
		));
	const existingRank = hasFile
		? qualityRank({
				format: track.format,
				bitrateKbps: track.bitrateKbps,
				bitDepth: track.bitDepth,
				isLossless: track.isLossless,
				sampleRateHz: track.sampleRateHz,
			})
		: -1;
	// The ceiling moved when Deezer gained a hi-res tier. "Is it 24-bit?" stopped
	// being the end of the question: a 24/44.1 file is still three tiers short,
	// and answering yes here is why hi-res masters were never hunted for.
	// Only a real file can be at a ceiling.
	if (hasFile && isAtCeiling(existingRank)) return null;
	// The 24h cooldown exists to stop the hourly sweep re-asking the same
	// question. For a row with NO file it is the wrong tool: the queue already
	// dedupes downloads per track, and a user pressing retry on a failed row is
	// asking for a fresh attempt, not for yesterday's answer.
	if (hasFile && !opts.skipRecentCheck && (await hasRecentUpgradeAttempt(track.id, 24)))
		return null;

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
		streamToken: null,
	};
	const prefs = prefsOf(settings);

	const candidates: UpgradeCandidate[] = [];
	const enabled = await enabledProviders();
	for (const provider of enabled) {
		try {
			let meta: TrackMeta = baseMeta;
			if (provider.id === track.provider) {
				// Same provider: refresh metadata for a live stream grant
				// (TRACK_TOKENs expire). Best-effort — Tidal falls back
				// to the stored snapshot when the instance can't resolve it.
				if (track.providerTrackId) {
					try {
						meta = await provider.metadata({
							provider: provider.id,
							id: track.providerTrackId,
							sourceUrl: track.sourceUrl ?? undefined,
						});
					} catch {
						meta = baseMeta;
					}
				}
			} else {
				// Cross-provider: locate the same recording — ISRC first (exact),
				// then a STRICT title/artist/duration match (never guess).
				let found: TrackMeta | null = null;
				if (track.isrc && provider.findByIsrcInAlbum) {
					// Preferred: the album hint disambiguates catalogues that reuse
					// one ISRC across a release and its compilations.
					found = await provider
						.findByIsrcInAlbum(track.isrc, track.artist, track.title, track.album)
						.catch(() => null);
				}
				if (!found && track.isrc && provider.findByIsrc) {
					const byIsrc = await provider.findByIsrc(track.isrc).catch(() => null);
					if (byIsrc) found = byIsrc;
				}
				if (!found && provider.search) {
					const metas = await provider
						.search(`${track.artist} ${track.title}`)
						.catch(() => []);
					const { findBestMatch } = await import('$lib/server/search/matcher');
					const verdict = findBestMatch(
						{
							title: track.title,
							artist: track.artist,
							album: track.album,
							durationSec: track.durationSec,
						},
						metas.map((m) => ({
							title: m.title,
							artist: m.artist,
							album: m.album,
							durationSec: m.durationSec,
						})),
					);
					if (verdict.candidate) {
						found =
							metas.find(
								(m) =>
									m.title === verdict.candidate?.title &&
									m.artist === verdict.candidate?.artist,
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
				isLossless: resolution.claimedLossless,
				sampleRateHz: resolution.claimedSampleRateHz ?? null,
			});
			if (incomingRank > existingRank) {
				candidates.push({ provider: provider.id, meta, resolution, incomingRank });
			}
		} catch (err) {
			log.debug('upgrade candidate unavailable', {
				provider: provider.id,
				trackId: track.id,
				error: String(err),
			});
		}
	}

	if (candidates.length === 0) return null;
	// Highest quality wins. `candidates` is in registry order (Tidal first), and
	// Array#sort is stable, so an exact tie falls to Tidal — which is also the
	// faster source, making it the better default even when quality matches.
	candidates.sort((a, b) => b.incomingRank - a.incomingRank);
	const best = candidates[0];
	if (!best) return null;
	return { ...best, incomingRank: best.incomingRank };
}
