import { describe, expect, it } from 'vitest';
import {
	bestPossibleFetch,
	isAtCeiling,
	isHiRes,
	isSameRecording,
	measuredIsBetter,
	mayReplaceFile,
	normalizeFormat,
	qualityRank,
	shouldSkipRefetch,
	shouldStopAlreadyDownloaded,
	upgradeIdentityProven,
	type QualityDescriptor,
} from './quality';

/**
 * These encode the rule the user's request depends on: keep trying until a song
 * is at the top tier, and never replace a file with something worse. A regression
 * here means either an endless refetch loop or a library that quietly stops
 * improving.
 *
 * "Top tier" was 24-bit until Deezer gained a hi-res master (verified live
 * 2026-10: `FLAC_24` on Pink Floyd — Money comes back 24-bit/96 kHz). 24-bit is
 * now a range, and the tests below pin the bands.
 */

const FLAC24 = { format: 'flac', bitrateKbps: null, bitDepth: 24, isLossless: true };
const FLAC16 = { format: 'flac', bitrateKbps: null, bitDepth: 16, isLossless: true };
const MP3_320 = { format: 'mp3', bitrateKbps: 320, bitDepth: null, isLossless: false };
const MP3_128 = { format: 'mp3', bitrateKbps: 128, bitDepth: null, isLossless: false };

describe('qualityRank', () => {
	it('separates the lossless tiers by sample rate', () => {
		// The three things that used to all be "24-bit". Collapsing them is what
		// made a 24/96 master unable to replace a 24/44.1 file.
		expect(qualityRank({ ...FLAC24, sampleRateHz: 44_100 })).toBe(4);
		expect(qualityRank({ ...FLAC24, sampleRateHz: 96_000 })).toBe(5);
		expect(qualityRank({ ...FLAC24, sampleRateHz: 192_000 })).toBe(6);
	});
	it('reads a 24-bit file of unstated rate as possibly hi-res', () => {
		// Deezer's format id carries no rate at all. Ranking it 4 would make every
		// such offer tie with a 24-bit file on disk and the upgrade would never be
		// attempted; `measuredIsBetter` is what keeps the optimism honest.
		expect(qualityRank(FLAC24)).toBe(5);
	});
	it('puts the ceiling at 24/192 and nothing above it', () => {
		expect(qualityRank({ ...FLAC24, sampleRateHz: 192_000 })).toBe(6);
		expect(isAtCeiling(6)).toBe(true);
		expect(isAtCeiling(5)).toBe(false);
	});
	it('ranks 16-bit FLAC above any MP3', () => {
		expect(qualityRank(FLAC16)).toBe(3);
		expect(qualityRank(MP3_320)).toBe(2);
		expect(qualityRank(MP3_128)).toBe(1);
	});
	it('treats a FLAC with unknown depth as 16-bit, not 24', () => {
		// Must not default to 24 — that would fake reaching the ceiling.
		expect(
			qualityRank({ format: 'flac', bitrateKbps: null, bitDepth: null, isLossless: true }),
		).toBe(3);
	});
	it('honours isLossless even when the format string disagrees', () => {
		expect(
			qualityRank({ format: 'm4a', bitrateKbps: null, bitDepth: 24, isLossless: true }),
		).toBe(5);
	});
	it('ranks unknown formats below everything understood', () => {
		expect(
			qualityRank({ format: 'aac', bitrateKbps: 256, bitDepth: null, isLossless: false }),
		).toBe(0);
	});

	// music-metadata reports an MP3's container as "MPEG". Without normalizing
	// that, every uploaded MP3 ranked 0 ("unknown") — worse than a 128 kbps
	// file — so the guardrail mishandled perfectly good uploads.
	it('treats a "mpeg" container as mp3, not as unknown', () => {
		expect(
			qualityRank({ format: 'mpeg', bitrateKbps: 320, bitDepth: null, isLossless: false }),
		).toBe(2);
		expect(
			qualityRank({ format: 'mpeg', bitrateKbps: 128, bitDepth: null, isLossless: false }),
		).toBe(1);
	});

	it('normalizes case and the MPEG variants', () => {
		for (const f of ['MPEG', 'Mpeg', 'mpeg-1', 'mpeg2', ' mp3 ']) {
			expect(
				qualityRank({ format: f, bitrateKbps: 320, bitDepth: null, isLossless: false }),
			).toBe(2);
		}
	});

	it('normalizes a FLAC container alias to lossless', () => {
		expect(
			qualityRank({ format: 'X-FLAC', bitrateKbps: null, bitDepth: 16, isLossless: false }),
		).toBe(3);
	});
});

describe('normalizeFormat', () => {
	it('maps containers to the families the ranker understands', () => {
		expect(normalizeFormat('MPEG')).toBe('mp3');
		expect(normalizeFormat('mp3')).toBe('mp3');
		expect(normalizeFormat('FLAC')).toBe('flac');
		expect(normalizeFormat('mp4')).toBe('aac');
		expect(normalizeFormat('VORBIS')).toBe('ogg');
	});

	it('passes anything else through lowercased and trimmed', () => {
		expect(normalizeFormat('WAV')).toBe('wav');
		expect(normalizeFormat('  Weird ')).toBe('weird');
	});
});

describe('the ceiling', () => {
	it('refuses to replace a 24/192 file with anything', () => {
		const TOP = { ...FLAC24, sampleRateHz: 192_000 };
		expect(shouldSkipRefetch(TOP, FLAC16).skip).toBe(true);
		expect(shouldSkipRefetch(TOP, MP3_320).skip).toBe(true);
		expect(shouldSkipRefetch(TOP, TOP).skip).toBe(true);
		expect(shouldSkipRefetch(TOP, { ...FLAC24, sampleRateHz: 96_000 }).skip).toBe(true);
	});

	it('names the ceiling as the reason', () => {
		const TOP = { ...FLAC24, sampleRateHz: 192_000 };
		expect(shouldSkipRefetch(TOP, FLAC16).reason).toBe('quality_ceiling_reached');
	});

	it('no longer treats plain 24-bit as the ceiling', () => {
		// This is the whole point of the change: a 24/44.1 file must still be
		// replaceable by a hi-res master. Before, both ranked 4 and the answer
		// here was "skip".
		const CD24 = { ...FLAC24, sampleRateHz: 44_100 };
		expect(shouldSkipRefetch(CD24, FLAC24).skip).toBe(false);
		expect(shouldSkipRefetch(CD24, { ...FLAC24, sampleRateHz: 192_000 }).skip).toBe(false);
	});

	it('still refuses to replace 24/96 with the 24-bit tier it already has', () => {
		const HIRES = { ...FLAC24, sampleRateHz: 96_000 };
		expect(shouldSkipRefetch(HIRES, FLAC24).skip).toBe(true);
		expect(shouldSkipRefetch(HIRES, HIRES).skip).toBe(true);
	});

	it('allows 24/44.1 to be replaced by a claimed hi-res offer', () => {
		// The claim has no rate in it (Deezer's `FLAC_24`), so it ranks as possibly
		// hi-res and outranks a measured 24/44.1. measuredIsBetter, run after the
		// download, is what stops a false positive from reaching the library.
		expect(shouldSkipRefetch({ ...FLAC24, sampleRateHz: 44_100 }, FLAC24).skip).toBe(false);
	});
});

describe('below the ceiling, upgrades proceed', () => {
	it('upgrades 16-bit FLAC with 24-bit FLAC', () => {
		const v = shouldSkipRefetch(FLAC16, FLAC24);
		expect(v.skip).toBe(false);
		expect(v.reason).toBeNull();
	});

	it('upgrades MP3 with any FLAC', () => {
		expect(shouldSkipRefetch(MP3_320, FLAC16).skip).toBe(false);
		expect(shouldSkipRefetch(MP3_128, FLAC24).skip).toBe(false);
	});

	it('does not replace lossless with lossy of any bitrate', () => {
		expect(shouldSkipRefetch(FLAC16, MP3_320).skip).toBe(true);
		expect(shouldSkipRefetch(FLAC16, MP3_128).skip).toBe(true);
	});

	it('does not replace an equal-quality file', () => {
		expect(shouldSkipRefetch(FLAC16, FLAC16).skip).toBe(true);
		expect(shouldSkipRefetch(MP3_320, MP3_320).skip).toBe(true);
	});

	it('allows a 320 upgrade over a low-bitrate MP3', () => {
		expect(shouldSkipRefetch(MP3_128, MP3_320).skip).toBe(false);
	});
});

describe('fallback policy', () => {
	it('permits a sub-320 MP3 when lower fallback is enabled', () => {
		expect(shouldSkipRefetch({ ...MP3_128, isLossless: false }, MP3_128).skip).toBe(false);
	});

	it('refuses a sub-320 MP3 when lower fallback is disabled', () => {
		const v = shouldSkipRefetch(MP3_128, MP3_128, { allowLowerFallback: false });
		expect(v.skip).toBe(true);
		expect(v.reason).toBe('below_min_bitrate_and_fallback_disabled');
	});

	it('still allows lossless when fallback is disabled', () => {
		expect(shouldSkipRefetch(MP3_320, FLAC16, { allowLowerFallback: false }).skip).toBe(false);
	});
});

describe('isSameRecording', () => {
	it('matches on equal ISRC regardless of case', () => {
		expect(isSameRecording('USQX91300108', 'usqx91300108')).toBe(true);
	});
	it('refuses on missing ISRCs', () => {
		expect(isSameRecording(null, 'USQX91300108')).toBe(false);
		expect(isSameRecording('USQX91300108', null)).toBe(false);
		expect(isSameRecording(null, null)).toBe(false);
	});
	it('refuses across different ISRCs', () => {
		expect(isSameRecording('USQX91300108', 'USQX91300109')).toBe(false);
	});
});

describe('the upgrade loop terminates', () => {
	it('converges: repeated 24-bit offers stop after the first success', () => {
		// Simulates the sweep running hourly against an unchanged catalogue.
		// Widened so the loop can hold any tier as the track improves.
		let existing: QualityDescriptor = MP3_320;
		let fetches = 0;
		for (let hour = 0; hour < 50; hour++) {
			if (shouldSkipRefetch(existing, FLAC24).skip) break;
			existing = FLAC24;
			fetches++;
		}
		expect(fetches).toBe(1);
		expect(qualityRank(existing)).toBe(5);
	});

	it('converges through every lossless tier up to 24/192', () => {
		let existing: QualityDescriptor = MP3_320;
		const path = [
			FLAC16,
			{ ...FLAC24, sampleRateHz: 44_100 },
			FLAC24,
			{ ...FLAC24, sampleRateHz: 192_000 },
		];
		for (const next of path) {
			expect(shouldSkipRefetch(existing, next).skip).toBe(false);
			existing = next;
		}
		expect(shouldSkipRefetch(existing, FLAC24).skip).toBe(true);
		expect(qualityRank(existing)).toBe(6);
	});

	it('does not thrash when the best available offer is only 16-bit', () => {
		let existing: QualityDescriptor = MP3_320;
		let fetches = 0;
		for (let hour = 0; hour < 50; hour++) {
			if (shouldSkipRefetch(existing, FLAC16).skip) break;
			existing = FLAC16;
			fetches++;
		}
		// One upgrade to 16-bit, then it stops — it must NOT keep refetching.
		expect(fetches).toBe(1);
		expect(qualityRank(existing)).toBe(3);
	});
});

describe('shouldStopAlreadyDownloaded', () => {
	// Regression: the quality guardrail only skips when the incoming copy cannot be
	// better, so a higher-ranked copy came back, got tagged (different bytes), and
	// moveIntoLibrary wrote "… (2).flac" / "(3).flac" beside the original. Navidrome
	// then saw several files claiming one track number and greyed the album out.
	it('stops when the recording already has a file', () => {
		expect(shouldStopAlreadyDownloaded({ hasFileOnDisk: true, isUpgrade: false })).toEqual({
			skip: true,
			reason: 'already_downloaded',
		});
	});

	it('lets an explicit upgrade through — replacing the file is its whole point', () => {
		expect(shouldStopAlreadyDownloaded({ hasFileOnDisk: true, isUpgrade: true })).toEqual({
			skip: false,
			reason: null,
		});
	});

	it('never stops when there is nothing on disk', () => {
		expect(shouldStopAlreadyDownloaded({ hasFileOnDisk: false, isUpgrade: false })).toEqual({
			skip: false,
			reason: null,
		});
		expect(shouldStopAlreadyDownloaded({ hasFileOnDisk: false, isUpgrade: true })).toEqual({
			skip: false,
			reason: null,
		});
	});
});

describe('measuredIsBetter — the check that runs after the download', () => {
	// Everything upstream of this compares a MEASURED file with a CLAIMED one, and
	// a claim is optimistic by construction. Deezer advertises `FLAC_24` and says
	// nothing about the rate, so the only sound place to decide whether a fetched
	// copy is worth keeping is after it has been probed.
	const MEASURED_24_96 = {
		format: 'flac',
		bitrateKbps: null,
		bitDepth: 24,
		isLossless: true,
		sampleRateHz: 96_000,
	};
	const MEASURED_24_44 = { ...MEASURED_24_96, sampleRateHz: 44_100 };

	it('keeps a hi-res file when the provider served 24/44.1 instead', () => {
		// The failure this prevents: the claim outranked the existing file, the
		// download replaced a 24/96 master with a CD-rate one, and the library got
		// quietly worse while every log said "upgraded".
		expect(measuredIsBetter(MEASURED_24_96, MEASURED_24_44)).toBe(false);
	});

	it('accepts a genuine upgrade', () => {
		expect(measuredIsBetter(MEASURED_24_44, MEASURED_24_96)).toBe(true);
		expect(measuredIsBetter(MEASURED_24_96, { ...MEASURED_24_96, sampleRateHz: 192_000 })).toBe(
			true,
		);
	});

	it('refuses an identical copy', () => {
		expect(measuredIsBetter(MEASURED_24_96, MEASURED_24_96)).toBe(false);
	});

	it('refuses any downgrade from a lossless file', () => {
		expect(
			measuredIsBetter(MEASURED_24_96, {
				format: 'flac',
				bitrateKbps: null,
				bitDepth: 16,
				isLossless: true,
				sampleRateHz: 44_100,
			}),
		).toBe(false);
		expect(
			measuredIsBetter(MEASURED_24_96, {
				format: 'mp3',
				bitrateKbps: 320,
				bitDepth: null,
				isLossless: false,
			}),
		).toBe(false);
	});

	it('is a strict comparison, not an improvement allowance', () => {
		// The handler substitutes the incoming copy for the missing side when
		// there is no row to replace, so this only ever sees two real files — and
		// "worse than the copy we have" must stay a refusal.
		expect(measuredIsBetter(MEASURED_24_44, MP3_128)).toBe(false);
	});
});

describe('isHiRes', () => {
	const flac = (bitDepth: number | null, sampleRateHz: number | null) =>
		qualityRank === undefined
			? null
			: { format: 'flac', bitrateKbps: null, bitDepth, isLossless: true, sampleRateHz };

	it('is true only for 24-bit sampled above CD rate', () => {
		expect(isHiRes(flac(24, 96_000)!)).toBe(true);
		expect(isHiRes(flac(24, 192_000)!)).toBe(true);
	});
	it('is false for CD-rate 24-bit and for 16-bit at any rate', () => {
		expect(isHiRes(flac(24, 44_100)!)).toBe(false);
		expect(isHiRes(flac(16, 96_000)!)).toBe(false);
	});
	it('is false when the rate was never recorded', () => {
		// A badge reading HI-RES beside a plain 24-bit label would be a claim the
		// library cannot back, so an unknown rate produces no badge.
		expect(isHiRes(flac(24, null)!)).toBe(false);
	});
	it('is false for lossy', () => {
		expect(
			isHiRes({
				format: 'mp3',
				bitrateKbps: 320,
				bitDepth: null,
				isLossless: false,
				sampleRateHz: 48_000,
			}),
		).toBe(false);
	});
});

describe('bestPossibleFetch', () => {
	it('is the top tier when hi-res is wanted', () => {
		const q = bestPossibleFetch(true);
		expect(qualityRank(q)).toBe(6);
		expect(isAtCeiling(qualityRank(q))).toBe(true);
	});
	it('stops at CD-rate 24-bit when hi-res is declined', () => {
		// Otherwise "don't fetch hi-res" would still let a 24/192 file count as the
		// thing worth fetching, and the sweep would chase it forever.
		expect(qualityRank(bestPossibleFetch(false))).toBe(4);
	});
	it('never leaves a 24-bit file un-improvable', () => {
		// The bug that made hi-res unreachable: the bound used to be a flat 24-bit,
		// which was also the ceiling, so nothing outranked an existing 24-bit file.
		expect(
			shouldSkipRefetch(
				{
					format: 'flac',
					bitrateKbps: null,
					bitDepth: 24,
					isLossless: true,
					sampleRateHz: 44_100,
				},
				bestPossibleFetch(true),
			).skip,
		).toBe(false);
	});
});

describe('mayReplaceFile', () => {
	const incoming24_96 = {
		format: 'flac',
		bitrateKbps: null,
		bitDepth: 24,
		isLossless: true,
		sampleRateHz: 96_000,
	};

	it('files the copy when the row holds no file at all', () => {
		// First, and deliberately. Refusing here would strand a track with no
		// audio: the upgrade was the only thing that was going to give it any.
		expect(mayReplaceFile(null, incoming24_96)).toBe(true);
	});

	it('files the copy when the row exists but its file is missing', () => {
		expect(
			mayReplaceFile(
				{
					format: 'flac',
					bitrateKbps: null,
					bitDepth: 16,
					isLossless: true,
					sampleRateHz: 44_100,
					hasFile: false,
				},
				incoming24_96,
			),
		).toBe(true);
	});

	it('refuses to downgrade a file that IS there', () => {
		expect(
			mayReplaceFile(
				{
					format: 'flac',
					bitrateKbps: null,
					bitDepth: 24,
					isLossless: true,
					sampleRateHz: 96_000,
					hasFile: true,
				},
				{
					format: 'flac',
					bitrateKbps: null,
					bitDepth: 24,
					isLossless: true,
					sampleRateHz: 44_100,
				},
			),
		).toBe(false);
	});

	it('replaces it when the copy is genuinely better', () => {
		expect(
			mayReplaceFile(
				{
					format: 'flac',
					bitrateKbps: null,
					bitDepth: 16,
					isLossless: true,
					sampleRateHz: 44_100,
					hasFile: true,
				},
				incoming24_96,
			),
		).toBe(true);
	});
});

describe('bestPossibleFetch vs what a provider can actually serve', () => {
	// The bound must not be lower than reality (that blocks real upgrades) nor
	// higher (that keeps the sweep chasing a tier nobody has).
	it('is at least as high as Deezer hi-res', () => {
		// Deezer answers `FLAC_24` with 24/96. Measured, not assumed.
		const deezerHiRes = {
			format: 'flac',
			bitrateKbps: null,
			bitDepth: 24,
			isLossless: true,
			sampleRateHz: 96_000,
		};
		expect(qualityRank(bestPossibleFetch(true))).toBeGreaterThanOrEqual(
			qualityRank(deezerHiRes),
		);
	});

	it('is at least as high as Tidal hi-res', () => {
		const tidalHiRes = {
			format: 'flac',
			bitrateKbps: null,
			bitDepth: 24,
			isLossless: true,
			sampleRateHz: 192_000,
		};
		expect(qualityRank(bestPossibleFetch(true))).toBeGreaterThanOrEqual(
			qualityRank(tidalHiRes),
		);
	});

	it('declining hi-res makes a 24/44.1 file final, as asked', () => {
		const cd = {
			format: 'flac',
			bitrateKbps: null,
			bitDepth: 24,
			isLossless: true,
			sampleRateHz: 44_100,
		};
		expect(shouldSkipRefetch(cd, bestPossibleFetch(false)).skip).toBe(true);
	});
});

describe('upgradeIdentityProven', () => {
	// The supersede step DELETES the file it replaces, so a wrong answer here is
	// destructive and silent — the row ends up carrying the other recording's
	// title, artist and ISRC and reads as a deliberate correction afterwards.
	it('accepts a same-provider upgrade without an ISRC', () => {
		// Safe by construction: the upgrade re-reads the same provider track id.
		expect(
			upgradeIdentityProven({
				fromProvider: 'deezer',
				toProvider: 'deezer',
				fromIsrc: null,
				toIsrc: null,
			}),
		).toBe(true);
	});

	it('accepts a cross-provider upgrade proven by equal ISRCs', () => {
		expect(
			upgradeIdentityProven({
				fromProvider: 'deezer',
				toProvider: 'tidal',
				fromIsrc: 'GBN9Y1100081',
				toIsrc: 'GBN9Y1100081',
			}),
		).toBe(true);
		expect(
			upgradeIdentityProven({
				fromProvider: 'deezer',
				toProvider: 'tidal',
				fromIsrc: 'GBN9Y1100081',
				toIsrc: 'gbn9y1100081',
			}),
		).toBe(true);
	});

	it('refuses a cross-provider upgrade with different ISRCs', () => {
		expect(
			upgradeIdentityProven({
				fromProvider: 'deezer',
				toProvider: 'tidal',
				fromIsrc: 'GBN9Y1100081',
				toIsrc: 'GBN9X1800018',
			}),
		).toBe(false);
	});

	it('refuses when either side lacks an ISRC — a missing ISRC proves nothing', () => {
		// The engine's last resort is an artist/title match, and a live take or a
		// remix answers to that name exactly. Refusing costs one missed upgrade;
		// guessing costs the original recording.
		expect(
			upgradeIdentityProven({
				fromProvider: 'deezer',
				toProvider: 'tidal',
				fromIsrc: 'GBN9Y1100081',
				toIsrc: null,
			}),
		).toBe(false);
		expect(
			upgradeIdentityProven({
				fromProvider: 'deezer',
				toProvider: 'tidal',
				fromIsrc: null,
				toIsrc: 'GBN9Y1100081',
			}),
		).toBe(false);
		expect(
			upgradeIdentityProven({
				fromProvider: 'deezer',
				toProvider: 'tidal',
				fromIsrc: null,
				toIsrc: null,
			}),
		).toBe(false);
	});
});
