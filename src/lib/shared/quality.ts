/**
 * Quality model + guardrails (spec: hard stop at 24-bit/192, min 320 kbps tier).
 *
 * Rank order (higher is better):
 *   6 = FLAC 24-bit above 96 kHz   (24/192 — the ceiling)
 *   5 = FLAC 24-bit, 88.2–96 kHz  (hi-res), or 24-bit of unstated rate
 *   4 = FLAC 24-bit, ≤ 48 kHz
 *   3 = FLAC 16-bit (any rate)
 *   2 = MP3 320 kbps
 *   1 = MP3 < 320 kbps (preview/scaffold tier — allowed only via fallback)
 *   0 = unknown format
 *
 * The ceiling used to be "24-bit" as a single tier. It is no longer one tier:
 * Deezer serves `FLAC_24` for part of its catalogue (verified live 2026-10: Pink
 * Floyd — Money comes back 24-bit/96 kHz, 134.7 MiB against 40.3 MiB for the
 * CD master) and Tidal reaches 24/192. A 24-bit file is therefore no longer the
 * end of the road, and treating it as one left 24/44.1 rows permanently
 * un-upgradeable because both sides of the comparison ranked 4.
 *
 * Sample rate is what separates those tiers, so it is part of the descriptor
 * rather than a label applied afterwards.
 */

export interface QualityDescriptor {
	/** Provider file format, e.g. 'mp3' | 'flac' (open string for unknown formats). */
	format: string;
	bitrateKbps: number | null;
	bitDepth: number | null;
	isLossless: boolean;
	/**
	 * Sample rate in Hz. Measured for files on disk; for a provider's *claim* it
	 * is whatever the provider states, which is often nothing — see
	 * `qualityRank` for how an unstated rate is treated.
	 */
	sampleRateHz?: number | null;
}

/** Above CD's 44.1 kHz — the point at which a lossless file is "hi-res". */
export const HIRES_MIN_SAMPLE_RATE_HZ = 48_000;
/** The highest tier worth fetching. Deezer tops out at 96 kHz, Tidal at 192. */
export const QUALITY_CEILING_RANK = 6;

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
		if ((q.bitDepth ?? 16) < 24) return 3;
		const rate = q.sampleRateHz ?? null;
		// A 24-bit file of UNSTATED rate is ranked as hi-res rather than as
		// 24/44.1, because that is what it usually is: providers advertise a
		// 24-bit tier and leave the rate out of the label. Deezer's format id is
		// literally `FLAC_24` with no rate anywhere in the response. Ranking it 4
		// would make every such offer compare equal to a 24-bit file already on
		// disk, and the hi-res upgrade would never be attempted at all.
		//
		// The optimistic reading only ever decides what to FETCH. The downloaded
		// file is then measured, and an upgrade that turns out not to be an
		// improvement is discarded before it can replace anything — see
		// `measuredIsBetter` and the post-probe check in the download handler.
		if (rate === null) return 5;
		if (rate <= 48_000) return 4;
		if (rate <= 96_000) return 5;
		return 6;
	}
	if (format === 'mp3') {
		return (q.bitrateKbps ?? 0) >= 320 ? 2 : 1;
	}
	// Unknown formats rank below everything we understand.
	return 0;
}

/** True when nothing we fetch could ever be better than this. */
export function isAtCeiling(rank: number): boolean {
	return rank >= QUALITY_CEILING_RANK;
}

/**
 * Is this a hi-res lossless file — 24-bit sampled above CD rate?
 *
 * Drives the badge in the UI, so an unstated rate does NOT count: a chip reading
 * "HI-RES" beside a plain 24-bit label would be a claim the library cannot back.
 */
export function isHiRes(q: QualityDescriptor): boolean {
	const format = normalizeFormat(q.format);
	if (!(q.isLossless || format === 'flac')) return false;
	if ((q.bitDepth ?? 16) < 24) return false;
	return (q.sampleRateHz ?? 0) > HIRES_MIN_SAMPLE_RATE_HZ;
}

/**
 * The comparison that must happen AFTER a file is measured, not before: is the
 * copy just downloaded worth putting in place of the one already on disk?
 *
 * Both sides are measured here, which is the point. `qualityRank` is fed a
 * provider's claim when deciding what to fetch, and a claim can be optimistic;
 * two measured copies cannot be. Without this, a provider that advertises a
 * 24-bit tier and serves 24/44.1 would replace a 24/96 file the moment its claim
 * outranked it.
 */
export function measuredIsBetter(
	existing: QualityDescriptor,
	incoming: QualityDescriptor,
): boolean {
	return qualityRank(incoming) > qualityRank(existing);
}

/**
 * May a freshly fetched copy take the place of an existing one?
 *
 * Two rules, and the order matters:
 *   1. If the row has no file, there is nothing to protect — the copy is filed.
 *      This has to come first. Refusing here would strand a track with no audio
 *      at all, which is the worst outcome the quality pipeline can produce: the
 *      upgrade was the only thing that was going to give it any.
 *   2. Otherwise both sides are MEASURED files, and the copy must be strictly
 *      better.
 *
 * `existing` is null when the row is gone or holds no file.
 */
export function mayReplaceFile(
	existing: (QualityDescriptor & { hasFile: boolean }) | null,
	incoming: QualityDescriptor,
): boolean {
	if (existing == null || !existing.hasFile) return true;
	return measuredIsBetter(existing, incoming);
}

/**
 * Guardrail: should we skip fetching `incoming` because an existing track for
 * the same ISRC/title is already at or above its quality?
 * The ceiling rule: once the top tier exists, nothing may replace it.
 */
export function shouldSkipRefetch(
	existing: QualityDescriptor,
	incoming: QualityDescriptor,
	opts: { allowLowerFallback: boolean } = { allowLowerFallback: true },
): { skip: boolean; reason: string | null } {
	const existingRank = qualityRank(existing);
	const incomingRank = qualityRank(incoming);

	if (isAtCeiling(existingRank)) {
		return { skip: true, reason: 'quality_ceiling_reached' };
	}
	if (incomingRank <= existingRank && existingRank >= 2) {
		return { skip: true, reason: 'equal_or_better_quality_exists' };
	}
	if (!opts.allowLowerFallback && incomingRank < 2) {
		return { skip: true, reason: 'below_min_bitrate_and_fallback_disabled' };
	}
	return { skip: false, reason: null };
}

/**
 * May this fetch REPLACE the row it was aimed at, identity-wise?
 *
 * The supersede step deletes the file it replaces, so a wrong answer here is
 * destructive and silent: the row then carries the other recording's title,
 * artist and ISRC, which reads as a deliberate correction afterwards.
 *
 * Same provider is safe by construction — the upgrade re-reads the same provider
 * track id. Cross-provider is not: when ISRC lookup fails, the upgrade engine
 * falls back to artist/title, and a live take or a remix answers to that name
 * exactly. So a cross-provider replacement must be proven by ISRC, on both sides.
 * A missing ISRC proves nothing and is treated as unproven — refusing here costs
 * one missed upgrade, while guessing costs the original recording.
 */
export function upgradeIdentityProven(input: {
	fromProvider: string;
	toProvider: string;
	fromIsrc: string | null | undefined;
	toIsrc: string | null | undefined;
}): boolean {
	if (input.fromProvider === input.toProvider) return true;
	return isSameRecording(input.fromIsrc, input.toIsrc);
}

/**
 * Should a download stop because this recording is already on disk?
 *
 * Separate from `shouldSkipRefetch`, which answers a different question: not
 * "do we have it" but "can the incoming copy be better". That gap is what produced
 * `07 - sludgecrank (2).flac` and `(3).flac` beside the original — a higher-ranked
 * copy was fetched, got tagged (so its bytes differed), and `moveIntoLibrary`
 * could not recognise it and suffixed instead of replacing. Navidrome then saw
 * several files claiming one track number and greyed the album out.
 *
 * An explicit upgrade is exempt, and only that: replacing a file on request is the
 * entire purpose of the quality pipeline.
 */
export function shouldStopAlreadyDownloaded(input: {
	/** A prior row for this recording has a file that still exists. */
	hasFileOnDisk: boolean;
	/** This run was explicitly asked to replace what is there. */
	isUpgrade: boolean;
}): { skip: boolean; reason: string | null } {
	if (input.isUpgrade) return { skip: false, reason: null };
	if (input.hasFileOnDisk) return { skip: true, reason: 'already_downloaded' };
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
 * The best copy this app will ever fetch, given the hi-res preference.
 *
 * The download handler needs an upper bound for the copy it is about to fetch,
 * because the guardrail runs before the stream is resolved. It must be the true
 * best, or the guardrail rejects an upgrade it should have allowed: while 24-bit
 * was a single tier, "24" was the whole ceiling and nothing could outrank it, so
 * a 24/44.1 file could never be improved.
 */
export function bestPossibleFetch(preferHiRes: boolean): QualityDescriptor {
	return {
		format: 'flac',
		bitrateKbps: null,
		bitDepth: 24,
		sampleRateHz: preferHiRes ? 192_000 : HIRES_MIN_SAMPLE_RATE_HZ,
		isLossless: true,
	};
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
