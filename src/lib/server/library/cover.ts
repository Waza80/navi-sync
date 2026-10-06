/**
 * Read cover bytes off disk so a re-tag can EMBED artwork.
 *
 * Why this exists: an album only has art on Navidrome if cover bytes are written
 * into the audio file. A `cover_path` in our database is a JPEG sitting beside
 * the track, and Navidrome never looks at it. Both whole-library re-tag paths
 * passed `cover: null`, so PRETTY DOLLCORPSE sat with 213 other albums having
 * art and 8 having none — including the one release whose MusicBrainz entry has
 * approved front and back images waiting.
 *
 * Reading the file we already have is the non-breaking implementation: no new
 * network call, no provider change, no effect on metadata resolution, and it
 * helps every album at once rather than only the ones a source can answer.
 */
import { readFile } from 'node:fs/promises';

/** Extensions we are willing to embed, longest first so `.jpeg` beats `.jpg`. */
const OK_EXT = ['.jpeg', '.jpg', '.png', '.webp', '.gif', '.bmp'];

/**
 * Cover bytes for `coverPath`, or null.
 *
 * Returns null for anything unusable rather than throwing: a missing cover, an
 * empty file, a path that escapes the library, or an unexpected extension. A
 * re-tag must never fail because a cover could not be read — the audio and its
 * text tags matter more, and `tagFlac` preserves an existing PICTURE block when
 * `cover` is null.
 *
 * `maxBytes` bounds the read. A provider returning a 40 MB 'cover' should not be
 * able to turn a tag repair into an OOM; anything larger is skipped and the
 * existing artwork stays.
 */
export async function readCoverBytes(
	coverPath: string | null | undefined,
	opts: { maxBytes?: number; libraryRoot?: string } = {},
): Promise<Buffer | null> {
	if (!coverPath) return null;
	const { maxBytes = 12 * 1024 * 1024, libraryRoot } = opts;

	const dot = coverPath.lastIndexOf('.');
	const ext = dot >= 0 ? coverPath.slice(dot).toLowerCase() : '';
	if (!OK_EXT.includes(ext)) return null;

	// Refuse anything that is not a plain absolute path. A traversal here would
	// read an arbitrary file into a tag, which is how a cover path becomes an
	// exfiltration primitive.
	if (coverPath.includes('\0')) return null;
	if (libraryRoot && !coverPath.startsWith(libraryRoot)) return null;
	if (!coverPath.startsWith('/')) return null;

	try {
		const buf = await readFile(coverPath);
		if (buf.length === 0 || buf.length > maxBytes) return null;
		// A real JPEG starts FFD8FF, a PNG 89504E47. Anything else is not an image
		// we should be embedding into a music file.
		const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
		const isPng =
			buf.length > 8 &&
			buf[0] === 0x89 &&
			buf[1] === 0x50 &&
			buf[2] === 0x4e &&
			buf[3] === 0x47;
		if (!isJpeg && !isPng) return null;
		return buf;
	} catch {
		return null;
	}
}

/** The MIME type a given cover buffer should be embedded as. */
export function coverMimeType(buf: Buffer): 'image/jpeg' | 'image/png' {
	return buf[0] === 0x89 ? 'image/png' : 'image/jpeg';
}
