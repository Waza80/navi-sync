/**
 * Quality model + guardrails (spec: hard stop at 24-bit, min 320 kbps tier).
 *
 * Rank order (higher is better):
 *   4 = FLAC 24-bit   (ceiling — never fetch/replace above or re-fetch below)
 *   3 = FLAC 16-bit
 *   2 = MP3 320 kbps
 *   1 = MP3 < 320 kbps (preview/scaffold tier — allowed only via fallback)
 */

export interface QualityDescriptor {
	/** Provider file format, e.g. 'mp3' | 'flac' (open string for unknown formats). */
	format: string;
	bitrateKbps: number | null;
	bitDepth: number | null;
	isLossless: boolean;
}

/**
 * Normalise the format names different probes produce.
 *
 * music-metadata reports an MP3's CONTAINER as "MPEG", not "mp3", so an
 * uploaded or downloaded MP3 arrives as `format: 'mpeg'`. Without this, every
 * MP3 ranked 0 ("unknown") instead of 2 (320 kbps) — which made the guardrail
 * treat known-good uploads as the worst possible quality and rank them below
 * even a 128 kbps file.
 */
export function normalizeFormat(format: string): string {
	const f = format.trim().toLowerCase();
	if (f === 'mpeg' || f === 'mpeg-1' || f === 'mpeg1' || f === 'mpeg-2' || f === 'mpeg2') {
		return 'mp3';
	}
	if (f === 'x-flac' || f === 'flac') return 'flac';
	if (f === 'mp4' || f === 'm4a' || f === 'aac') return 'aac';
	if (f === 'vorbis' || f === 'opus') return 'ogg';
	return f;
}

export function qualityRank(q: QualityDescriptor): number {
	const format = normalizeFormat(q.format);
	if (q.isLossless || format === 'flac') {
		return (q.bitDepth ?? 16) >= 24 ? 4 : 3;
	}
	if (format === 'mp3') {
		return (q.bitrateKbps ?? 0) >= 320 ? 2 : 1;
	}
	// Unknown formats rank below everything we understand.
	return 0;
}

/**
 * Guardrail: should we skip fetching `incoming` because an existing track for
 * the same ISRC/title is already at or above its quality?
 * The 24-bit ceiling rule: once 24-bit exists, nothing else may replace it.
 */
export function shouldSkipRefetch(
	existing: QualityDescriptor,
	incoming: QualityDescriptor,
	opts: { allowLowerFallback: boolean } = { allowLowerFallback: true },
): { skip: boolean; reason: string | null } {
	const existingRank = qualityRank(existing);
	const incomingRank = qualityRank(incoming);

	if (existingRank >= 4) {
		return { skip: true, reason: '24bit_ceiling_reached' };
	}
	if (incomingRank <= existingRank && existingRank >= 2) {
		return { skip: true, reason: 'equal_or_better_quality_exists' };
	}
	if (!opts.allowLowerFallback && incomingRank < 2) {
		return { skip: true, reason: 'below_min_bitrate_and_fallback_disabled' };
	}
	return { skip: false, reason: null };
}

/** Pick the best stream offer from a provider's candidates under user policy. */
export function selectBestQuality(
	candidates: QualityDescriptor[],
	prefs: { preferLossless: boolean; minBitrateKbps: number; allowLowerFallback: boolean },
): { chosen: QualityDescriptor | null; reason: string | null } {
	if (candidates.length === 0) return { chosen: null, reason: 'no_candidates' };

	const ranked = [...candidates].sort((a, b) => qualityRank(b) - qualityRank(a));
	const lossless = ranked.find((c) => qualityRank(c) >= 3);
	if (prefs.preferLossless && lossless) return { chosen: lossless, reason: 'lossless_available' };

	const meetsMin = ranked.find((c) => (c.bitrateKbps ?? 0) >= prefs.minBitrateKbps);
	if (meetsMin) {
		// Prefer the highest-ranked candidate that still meets the floor.
		return { chosen: meetsMin, reason: 'meets_min_bitrate' };
	}
	if (prefs.allowLowerFallback) {
		return { chosen: ranked[ranked.length - 1], reason: 'lower_fallback' };
	}
	return { chosen: null, reason: 'no_candidate_meets_min_bitrate' };
}

/**
 * Identity check for row replacement: two rows are the SAME recording only
 * when both carry a non-empty, case-insensitively equal ISRC. Title/artist
 * matches are deliberately NOT enough (live versions, remixes, same-name
 * tracks) — replacing those would destroy the wrong song.
 */
export function isSameRecording(
	existingIsrc: string | null | undefined,
	incomingIsrc: string | null | undefined,
): boolean {
	if (!existingIsrc || !incomingIsrc) return false;
	return existingIsrc.toLowerCase() === incomingIsrc.toLowerCase();
}
