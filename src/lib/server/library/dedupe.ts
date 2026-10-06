/**
 * Refuses to file a second copy of a file it already has.
 *
 * The failure this prevents is silent and hard to undo: a duplicate download
 * lands beside the original, Navidrome indexes both, and a listener sees two
 * entries for one song. It happens whenever a provider reports a track under a
 * second album or a second disc — a reissue, a deluxe track, a "remaster" entry
 * — which is routine, not exceptional.
 *
 * Two questions, in order:
 *
 *  1. Do we already have this exact recording? Compared by CONTENT, not by
 *     title. `isDuplicateContent` takes the checksum; matching on
 *     title+duration alone is how "POCKET ROCKET" and "POCKET ROCKET (Remix)"
 *     get wrongly refused as duplicates of each other.
 *  2. If not, does this DESTINATION path already hold a file? If so the write is
 *     skipped, never appended. `targetExists` decides, and the caller must not
 *     invent a ` (2)`.
 */

export interface ContentRef {
	/** Where the held copy lives, so a refusal can say which file won. */
	filePath?: string;
	checksumSha256?: string | null;
	sizeBytes?: number | null;
	durationSec?: number | null;
	title?: string | null;
}

export interface DuplicateDecision {
	duplicate: boolean;
	/** Why — a log line and a job result both need this. */
	reason: 'same-checksum' | 'same-size-and-duration' | 'destination-occupied' | 'distinct';
	/** The already-held file, when there is one. */
	against?: { filePath: string; checksumSha256?: string | null };
}

const TOLERANCE_SEC = 1.5;

export function isDuplicateContent(
	incoming: ContentRef,
	held: readonly ContentRef[],
): DuplicateDecision {
	// A checksum is proof. Anything else is inference.
	if (incoming.checksumSha256) {
		for (const h of held) {
			if (h.checksumSha256 && h.checksumSha256 === incoming.checksumSha256) {
				return {
					duplicate: true,
					reason: 'same-checksum',
					against: { filePath: h.filePath ?? '', checksumSha256: h.checksumSha256 },
				};
			}
		}
	}
	// Size AND duration agreeing is a strong signal for a lossless copy, and it is
	// only consulted when no checksum is available.
	if (incoming.sizeBytes != null && incoming.durationSec != null) {
		for (const h of held) {
			if (h.sizeBytes == null || h.durationSec == null) continue;
			if (h.sizeBytes !== incoming.sizeBytes) continue;
			if (Math.abs(h.durationSec - incoming.durationSec) > TOLERANCE_SEC) continue;
			return {
				duplicate: true,
				reason: 'same-size-and-duration',
				against: { filePath: h.filePath ?? '', checksumSha256: h.checksumSha256 },
			};
		}
	}
	return { duplicate: false, reason: 'distinct' };
}

/**
 * True when the destination path is already taken.
 *
 * Deliberately NOT a "find a free name" helper. Appending ` (2)` is how a library
 * ends up with two entries for one recording, and it is much worse than refusing
 * a write. When this returns true the caller must skip the file, leaving the
 * existing one in place — which is also the better copy, since it is the one
 * already indexed and matched to its row.
 */
export function targetExists(destPath: string, exists: (p: string) => boolean): boolean {
	return exists(destPath);
}
