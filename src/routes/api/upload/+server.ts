import type { RequestHandler } from './$types';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { json, badRequest, notFound, unauthorizedResponse } from '$lib/server/api';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';
import { cleanupTemp, moveIntoLibrary, sha256File } from '$lib/server/library/files';
import { embedLyrics, probeQuality, tagFlac, tagMp3 } from '$lib/server/library/tagging';
import { coverRelativePath, trackBaseRelativePath } from '$lib/server/library/paths';
import { findLibraryDuplicate, upsertTrack } from '$lib/server/db/tracks';
import { downloadLyrics } from '$lib/server/lyrics';
import { readLyricsSidecar } from '$lib/server/lyrics/sidecar';
import type { TrackMeta } from '$lib/server/providers/types';
import type { MetadataPatch } from '$lib/server/metadata/types';

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
	/** ISRC detected at inspect time; lets cover art resolve by exact release. */
	isrc: z.string().max(64).nullable().optional(),
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

/**
 * Cover bytes for an upload, preferring catalog artwork over a name search.
 *
 * A self-released album is typically absent from Deezer and Apple's stores while
 * MusicBrainz still has the release and the Cover Art Archive serves its front
 * image — so the enrichment path is what actually finds art for the uploads that
 * need it most.
 */
async function resolveUploadCover(
	input: z.infer<typeof finalizeSchema>,
	isrc: string | null,
): Promise<Buffer | null> {
	const { fetchCover } = await import('$lib/server/library/tagging');
	try {
		const { enrichTrackMetadata } = await import('$lib/server/metadata');
		const res = await enrichTrackMetadata({
			trackId: input.uploadId,
			title: input.title,
			artist: input.artist,
			album: input.album,
			isrc,
			durationSec: null,
			year: input.year ?? null,
			needed: ['coverUrl'],
		});
		if (res.patch.coverUrl) {
			const bytes = await fetchCover(res.patch.coverUrl);
			if (bytes) return bytes;
		}
	} catch (err) {
		log.warn('upload cover enrichment failed', { error: String(err) });
	}
	const { fetchAlbumArt } = await import('$lib/server/library/coverart');
	return fetchAlbumArt(input.artist, input.album);
}

async function finalizeUpload(input: z.infer<typeof finalizeSchema>): Promise<Response> {
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

	// Album art.
	//
	// An upload has no provider cover URL, and the previous Deezer-only lookup
	// meant a release Deezer has never heard of got NO artwork — which is exactly
	// the case for a self-released album, even though MusicBrainz has it and the
	// Cover Art Archive serves a real front image for it. So artwork is resolved
	// through the same metadata enrichment used for everything else (Tidal →
	// MusicBrainz/Cover Art Archive → Deezer → Apple), and only falls back to the
	// bare Deezer album search if that yields nothing.
	const coverBytes = await resolveUploadCover(input, input.isrc ?? null);

	// MusicBrainz enrichment: resolve artist/album MBIDs and correct metadata
	// from the canonical source. This fixes cases where the user-provided artist
	// is a merged credit list (e.g. PRETTY DOLLCORPSE) instead of the canonical
	// MusicBrainz artist. We ask for MBIDs and any descriptive fields that are
	// missing or look like they need correction.
	const { enrichTrackMetadata, neededFieldsFor } = await import('$lib/server/metadata');
	type Enrichment = { patch: MetadataPatch; filledBy: Record<string, string>; tried: string[] };
	let mbEnrichment: Enrichment;
	try {
		mbEnrichment = await enrichTrackMetadata({
			trackId: input.uploadId,
			title: input.title,
			artist: input.artist,
			album: input.album ?? null,
			isrc: input.isrc ?? null,
			durationSec: null,
			year: input.year ?? null,
			needed: neededFieldsFor({
				album: input.album,
				albumArtist: input.albumArtist ?? input.artist,
				artist: input.artist,
				coverPath: coverBytes ? 'present' : null,
				genre: input.genre ?? null,
				releaseYear: input.year ?? null,
				trackNumber: input.trackNumber ?? null,
				discNumber: input.discNumber ?? null,
				isrc: input.isrc ?? null,
				artistMbid: null,
				recordingMbid: null,
				releaseMbid: null,
				releaseGroupMbid: null,
				albumArtistMbid: null,
				releaseTrackMbid: null,
			}),
		});
	} catch (err) {
		log.warn('upload MusicBrainz enrichment failed', { error: String(err) });
		mbEnrichment = { patch: {}, filledBy: {}, tried: [] };
	}
	// Apply MusicBrainz corrections to meta before tagging/filing.
	// MusicBrainz is authoritative for artist and release facts.
	if (mbEnrichment.patch.artist) meta.artist = mbEnrichment.patch.artist;
	if (mbEnrichment.patch.album) meta.album = mbEnrichment.patch.album;
	if (mbEnrichment.patch.albumArtist) meta.albumArtist = mbEnrichment.patch.albumArtist;
	if (mbEnrichment.patch.year) meta.year = mbEnrichment.patch.year;
	if (mbEnrichment.patch.trackNumber) meta.trackNumber = mbEnrichment.patch.trackNumber;
	if (mbEnrichment.patch.discNumber) meta.discNumber = mbEnrichment.patch.discNumber;
	if (mbEnrichment.patch.isrc) meta.isrc = mbEnrichment.patch.isrc;
	if (mbEnrichment.patch.recordingMbid) meta.recordingMbid = mbEnrichment.patch.recordingMbid;
	if (mbEnrichment.patch.releaseMbid) meta.releaseMbid = mbEnrichment.patch.releaseMbid;
	if (mbEnrichment.patch.releaseGroupMbid)
		meta.releaseGroupMbid = mbEnrichment.patch.releaseGroupMbid;
	if (mbEnrichment.patch.albumArtistMbid)
		meta.albumArtistMbid = mbEnrichment.patch.albumArtistMbid;
	if (mbEnrichment.patch.releaseTrackMbid)
		meta.releaseTrackMbid = mbEnrichment.patch.releaseTrackMbid;
	if (mbEnrichment.patch.artistMbid) meta.artistMbid = mbEnrichment.patch.artistMbid;

	// Canonical tag values, shared by the initial write and the lyrics embed.
	// MusicBrainz-corrected values win over user input: album, albumArtist,
	// year, track/disc numbers and ISRC are authoritative from MusicBrainz.
	const tagData = {
		title: meta.title,
		artist: meta.artist,
		album: meta.album,
		albumArtist: meta.albumArtist ?? meta.artist,
		trackNumber: meta.trackNumber,
		discNumber: meta.discNumber,
		year: meta.year,
		genre: meta.genre,
		cover: coverBytes,
		lyricsPlain: null,
		lyricsSynced: null,
		// MusicBrainz identities, written to MP3/FLAC tags (WAV has no tag
		// writer — those rows carry the identities in the DB only).
		artistMbid: meta.artistMbid ?? null,
		recordingMbid: meta.recordingMbid ?? null,
		releaseMbid: meta.releaseMbid ?? null,
		releaseGroupMbid: meta.releaseGroupMbid ?? null,
		albumArtistMbid: meta.albumArtistMbid ?? null,
		releaseTrackMbid: meta.releaseTrackMbid ?? null,
	};

	// Tag the file. `cover` is embedded AND written as a canonical cover.jpg so
	// Navidrome (which ignores embedded art for MP3 in some paths) finds it.
	async function ctxTag() {
		try {
			if (container === 'flac') await tagFlac(tmpPath, tagData);
			else if (container === 'mp3') tagMp3(tmpPath, tagData);
		} catch (err) {
			// Tagging failing means Navidrome cannot identify the file at all, so
			// this is worth surfacing rather than silently filing a blank file.
			log.error('upload tagging failed', { error: String(err), path: tmpPath });
			throw err;
		}
	}
	// Containers with no tagging writer keep whatever tags they arrived with.
	if (taggable) await ctxTag();

	// The final path is needed BEFORE the move: the lyrics sidecar has to be
	// written beside the audio, not at a path re-derived from its tags.
	const relPath = `${trackBaseRelativePath(meta)}.${container}`;
	const plannedPath = join(env.MUSIC_LIBRARY_DIR, relPath);

	// Lyrics: embedded ones were already tagged by the uploader — otherwise
	// fetch ONLY when the song misses lyrics (no sidecar beside its final path).
	let lyricsStatus: 'none' | 'synced' | 'plain' | 'failed' | 'instrumental' = 'none';
	let lyricsSource: string | undefined;
	let pendingLyrics: { text: string; synced: boolean } | null = null;
	if (input.embeddedLyrics) {
		lyricsStatus = 'plain';
	} else if (input.fetchLyrics) {
		let current = await readLyricsSidecar(plannedPath);
		if (!current || !current.synced) {
			const result = await downloadLyrics(meta, plannedPath);
			if (result.success && result.path) {
				current = {
					text: await readFile(result.path, 'utf8'),
					synced: result.synced === true,
					path: result.path,
				};
				lyricsSource = result.source;
			} else if (result.instrumental) {
				lyricsStatus = 'instrumental';
			}
		}
		if (current) {
			lyricsStatus = current.synced ? 'synced' : 'plain';
			pendingLyrics = current;
		}
	}

	// File into the library.
	const checksum = await sha256File(tmpPath);
	const probed = await probeQuality(tmpPath).catch(() => null);
	const finalPath = await moveIntoLibrary(tmpPath, relPath);
	await cleanupTemp(tmpPath);

	// Embed fetched lyrics into the filed copy. The sidecar alone is invisible to
	// Navidrome, whose player renders the `LYRICS` tag captured at scan time.
	let lyricsEmbeddedAt: Date | null = null;
	if (pendingLyrics) {
		const embedded = await embedLyrics(finalPath, { ...tagData, cover: null }, pendingLyrics);
		if (embedded === 'ok') lyricsEmbeddedAt = new Date();
	}

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
			// Absolute, not relative: cover_path is stat()'d directly.
			coverPath = dest;
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
			format: container === 'flac' || container === 'wav' ? 'flac' : 'mp3',
			ext: container === 'flac' || container === 'wav' ? 'flac' : 'mp3',
			claimedBitrateKbps: null,
			claimedLossless: container === 'flac' || container === 'wav',
			cipher: 'NONE',
			decryptTrackId: null,
		},
		probed,
		filePath: finalPath,
		coverPath,
		sizeBytes: size,
		checksumSha256: checksum,
		lyricsStatus,
		lyricsSource,
		lyricsEmbeddedAt,
	});

	log.info('upload finalized', { trackId, filePath: finalPath, lyricsStatus });
	return json({
		trackId,
		filePath: finalPath,
		probed,
		lyricsStatus,
	});
}

void coverRelativePath;
