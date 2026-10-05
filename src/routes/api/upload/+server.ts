import type { RequestHandler } from './$types';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { json, badRequest, notFound, unauthorizedResponse } from '$lib/server/api';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';
import { cleanupTemp, moveIntoLibrary, sha256File } from '$lib/server/library/files';
import { probeQuality, tagFlac, tagMp3 } from '$lib/server/library/tagging';
import { coverRelativePath, trackBaseRelativePath } from '$lib/server/library/paths';
import { findLibraryDuplicate, upsertTrack } from '$lib/server/db/tracks';
import { downloadLyrics, lyricsSidecar } from '$lib/server/lyrics';
import type { TrackMeta } from '$lib/server/providers/types';

const log = logger;

/**
 * POST /api/upload — finalize a previously inspected upload.
 * Applies user-confirmed metadata (prompted addition), tags the file, writes
 * an `.lrc` when embedded/sourced lyrics exist, and files it into the
 * Navidrome layout with a `provider='upload'` track row.
 */

const finalizeSchema = z.object({
	uploadId: z.string().uuid(),
	ext: z.string().regex(/^\.[a-z0-9]{2,5}$/i),
	title: z.string().min(1).max(300),
	artist: z.string().min(1).max(300),
	album: z.string().min(1).max(300),
	albumArtist: z.string().max(300).optional(),
	trackNumber: z.coerce.number().int().min(0).max(999).nullable().optional(),
	discNumber: z.coerce.number().int().min(0).max(99).nullable().optional(),
	year: z.coerce.number().int().min(1000).max(3000).nullable().optional(),
	genre: z.string().max(100).nullable().optional(),
	embeddedLyrics: z.boolean().optional(),
	fetchLyrics: z.boolean().optional().default(true),
});

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return unauthorizedResponse();
	const parsed = finalizeSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return badRequest(
			`Invalid upload payload: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
			'INVALID_BODY',
		);
	}
	const input = parsed.data;

	try {
		return await finalizeUpload(input);
	} catch (err) {
		// Failed uploads stay visible as failed rows (same as downloads).
		const { ensureFailedTrackRow } = await import('$lib/server/db/tracks');
		const trackId = await ensureFailedTrackRow({
			provider: 'upload',
			providerTrackId: input.uploadId,
			title: input.title,
			artist: input.artist,
			album: input.album,
			year: input.year ?? null,
			genre: input.genre ?? null,
			error: err instanceof Error ? err.message : String(err),
		}).catch(() => null);
		log.warn('upload finalize failed', { error: String(err), trackId });
		return json(
			{
				error: {
					code: 'UPLOAD_FAILED',
					message: err instanceof Error ? err.message : 'Upload failed',
					trackId,
				},
			},
			{ status: 500 },
		);
	}
};

async function finalizeUpload(input: z.infer<typeof finalizeSchema>): Promise<Response> {
	// Locate the temp file from the inspect step.
	const prefix = `upload-${input.uploadId}.`;
	const entries = await readdir(env.MUSIC_TMP_DIR).catch(() => [] as string[]);
	const tmpName = entries.find((n) => n.startsWith(prefix));
	if (!tmpName) return notFound('Upload expired — inspect the file again.');
	const tmpPath = join(env.MUSIC_TMP_DIR, tmpName);
	const size = await stat(tmpPath)
		.then((s) => s.size)
		.catch(() => 0);
	if (size === 0) return notFound('Upload expired — inspect the file again.');

	const ext = input.ext.toLowerCase().replace(/^\./, '');
	// Every container the client-side picker and the inspect probe accept. Only
	// mp3 and flac are TAGGED (node-id3 and metaflac respectively); anything else
	// is filed with the tags it already carries, which is the honest outcome —
	// better than refusing a file the user clearly wants in their library.
	const TAGABLE = new Set(['mp3', 'flac']);
	const FILABLE = new Set(['mp3', 'flac', 'm4a', 'mp4', 'aac', 'ogg', 'opus', 'wav', 'wma']);
	const container = ext === 'mp3' || ext === 'flac' ? ext : FILABLE.has(ext) ? ext : null;
	if (!container) {
		await cleanupTemp(tmpPath);
		return badRequest(
			`Unsupported file type (.${ext}). Supported: ${[...FILABLE].map((e) => '.' + e).join(', ')}.`,
			'UNSUPPORTED_TYPE',
		);
	}
	const taggable = TAGABLE.has(container);

	// Dedupe: a song already in the library (title+artist) must never appear
	// twice. Short-circuit politely instead of creating a second row.
	const duplicate = await findLibraryDuplicate(input.title, input.artist);
	if (duplicate?.filePath) {
		await cleanupTemp(tmpPath);
		log.info('upload rejected as duplicate', { trackId: duplicate.id, title: input.title });
		return json(
			{
				duplicate: true,
				trackId: duplicate.id,
				message: 'This song is already in your library.',
			},
			{ status: 200 },
		);
	}

	const meta: TrackMeta = {
		provider: 'upload',
		providerTrackId: input.uploadId,
		title: input.title,
		artist: input.artist,
		album: input.album,
		albumArtist: input.albumArtist ?? input.artist,
		isrc: null,
		trackNumber: input.trackNumber ?? null,
		discNumber: input.discNumber ?? null,
		durationSec: null,
		year: input.year ?? null,
		genre: input.genre ?? null,
		coverUrl: null,
		sourceUrl: null,
		streamToken: null,
	};

	// Album art: an upload has no provider cover URL, so fall back to a public
	// cover-art search. Without this the file is filed with cover_path = NULL
	// and Navidrome shows a placeholder forever (art is optional, so a miss is
	// not an error — but a hit is worth the one request).
	const { fetchAlbumArt } = await import('$lib/server/library/coverart');
	const coverBytes = await fetchAlbumArt(input.artist, input.album);

	// Tag the file. `cover` is embedded AND written as a canonical cover.jpg so
	// Navidrome (which ignores embedded art for MP3 in some paths) finds it.
	async function ctxTag() {
		const tags = {
			title: input.title,
			artist: input.artist,
			album: input.album,
			albumArtist: input.albumArtist ?? input.artist,
			trackNumber: input.trackNumber ?? null,
			discNumber: input.discNumber ?? null,
			year: input.year ?? null,
			genre: input.genre ?? null,
			cover: coverBytes,
			lyricsPlain: null,
			lyricsSynced: null,
		};
		try {
			if (container === 'flac') await tagFlac(tmpPath, tags);
			else if (container === 'mp3') tagMp3(tmpPath, tags);
		} catch (err) {
			// Tagging failing means Navidrome cannot identify the file at all, so
			// this is worth surfacing rather than silently filing a blank file.
			log.error('upload tagging failed', { error: String(err), path: tmpPath });
			throw err;
		}
	}
	// Containers with no tagging writer keep whatever tags they arrived with.
	if (taggable) await ctxTag();

	// Lyrics: embedded ones were already tagged by the uploader — otherwise
	// fetch ONLY when the song misses lyrics (no sidecar at its library path).
	let lyricsStatus: 'none' | 'synced' | 'plain' | 'failed' = 'none';
	let lyricsPath: string | null = null;
	if (input.embeddedLyrics) {
		lyricsStatus = 'plain';
	} else if (input.fetchLyrics && (await lyricsSidecar(meta)) == null) {
		const result = await downloadLyrics(meta);
		if (result.success) {
			lyricsStatus = result.synced ? 'synced' : 'plain';
			lyricsPath = result.path ?? null;
		}
	}

	// File into the library.
	const checksum = await sha256File(tmpPath);
	const probed = await probeQuality(tmpPath).catch(() => null);
	const relPath = `${trackBaseRelativePath(meta)}.${container}`;
	const finalPath = await moveIntoLibrary(tmpPath, relPath);
	await cleanupTemp(tmpPath);

	// Write the canonical cover.jpg next to the track so Navidrome's folder-based
	// artwork lookup finds it, and record the path.
	let coverPath: string | null = null;
	if (coverBytes) {
		const relCover = coverRelativePath({
			title: input.title,
			artist: input.artist,
			album: input.album,
			trackNumber: input.trackNumber ?? null,
		});
		try {
			const { mkdir, writeFile } = await import('node:fs/promises');
			const dest = join(env.MUSIC_LIBRARY_DIR, relCover);
			await mkdir(dirname(dest), { recursive: true });
			await writeFile(dest, coverBytes);
			coverPath = relCover;
		} catch (err) {
			log.warn('upload cover write failed', { error: String(err) });
		}
	}

	const trackId = await upsertTrack({
		meta,
		// An upload is not a provider stream, so `StreamResolution` does not apply.
		// The real container and losslessness come from `probed` below; these two
		// are only fallbacks for when the probe fails.
		resolution: {
			url: '',
			format: container === 'flac' ? 'flac' : 'mp3',
			ext: container === 'flac' ? 'flac' : 'mp3',
			claimedBitrateKbps: null,
			claimedLossless: container === 'flac',
			cipher: 'NONE',
			decryptTrackId: null,
		},
		probed,
		filePath: finalPath,
		coverPath,
		sizeBytes: size,
		checksumSha256: checksum,
		lyricsStatus,
	});
	void lyricsPath;

	log.info('upload finalized', { trackId, filePath: finalPath, lyricsStatus });
	return json({
		trackId,
		filePath: finalPath,
		probed,
		lyricsStatus,
	});
}

void coverRelativePath;
