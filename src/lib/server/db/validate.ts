import { z } from 'zod';

/**
 * Runtime shapes for values that reach the database.
 *
 * Types vanish at runtime, so nothing stopped `provider_track_id` from being handed
 * a full URL. That column is half of the `(provider, provider_track_id)` unique key,
 * so a URL there cannot match a canonical id or an ISRC lookup: 29 rows appeared
 * titled "Failed download" by "Unknown Artist", one of them storing
 * "https://www.deezer.com/fr/artist/110750" as a track id. A schema at the DB
 * boundary refuses the value instead of the type system failing to mention it.
 *
 * `PROVIDER_ID_RE` is deliberately strict: provider-native ids are digits (Deezer
 * SNG_ID, Tidal track id), `mbid-…` for uploads, and the long opaque strings some
 * sources use. A `://` can never be legitimate.
 */

/** A URL is never a valid provider track id. */
export const NOT_A_TRACK_ID = z
	.string()
	.min(1)
	.max(200)
	.refine((v) => !/^\s*https?:\/\//i.test(v), {
		message: 'provider track id must not be a URL',
	})
	.refine((v) => v.trim() === v && v.length > 0, {
		message: 'provider track id must not be blank or padded',
	});

/** A library path: absolute, no traversal, no NUL, and inside the library. */
export const libraryPath = z
	.string()
	.min(1)
	.max(1024)
	.refine((v) => !v.includes('\0'), { message: 'path must not contain NUL' })
	.refine((v) => !/(^|[\\/])\.\.([\\/]|$)/.test(v), {
		message: 'path must not traverse outside the library',
	});

export const trackRowSchema = z.object({
	provider: z.string().min(1).max(50),
	providerTrackId: NOT_A_TRACK_ID,
	title: z.string().min(1).max(500),
	artist: z.string().min(1).max(500),
	album: z.string().max(500).nullable(),
	albumArtist: z.string().max(500).nullable(),
	isrc: z
		.string()
		.max(20)
		.nullable()
		// ISRC is CC12-4C11-AAAAA: 2 country + 3 registrant + 2 year + 5 serial.
		.refine((v) => v == null || /^[A-Z]{2}[A-Z0-9]{3}\d{2}[A-Z0-9]{5}$/i.test(v), {
			message: 'isrc must look like an ISRC',
		}),
	trackNumber: z.number().int().min(0).max(9999).nullable(),
	discNumber: z.number().int().min(0).max(999).nullable(),
	releaseYear: z.number().int().min(1850).max(2200).nullable(),
	genre: z.string().max(200).nullable(),
	durationSec: z
		.number()
		.min(0)
		.max(60 * 60 * 12)
		.nullable(),
	filePath: z.string().max(1024).nullable(),
	coverPath: z.string().max(1024).nullable(),
	downloadStatus: z.enum(['pending', 'completed', 'failed']),
});

export type ValidatedTrackRow = z.infer<typeof trackRowSchema>;

/**
 * Thrown when a value that should never reach the database does.
 *
 * A distinct class so callers can let it propagate: silently dropping an invalid
 * write would hide the bug, which is how the URL-in-id rows survived unnoticed.
 */
export class DbInvariantError extends Error {
	readonly issues: z.ZodIssue[];
	constructor(message: string, issues: z.ZodIssue[]) {
		super(message);
		this.name = 'DbInvariantError';
		this.issues = issues;
	}
}

/** Validate, throwing `DbInvariantError` rather than returning a result. */
export function assertValidTrackRow(input: unknown): ValidatedTrackRow {
	const parsed = trackRowSchema.safeParse(input);
	if (!parsed.success) {
		throw new DbInvariantError(
			`Refusing to write an invalid track row: ${parsed.error.issues
				.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
				.join('; ')}`,
			parsed.error.issues,
		);
	}
	return parsed.data;
}

/** Validate without throwing. Use on read paths where one bad row must not fail all. */
export function safeValidateTrackRow(input: unknown): ValidatedTrackRow | null {
	const parsed = trackRowSchema.safeParse(input);
	return parsed.success ? parsed.data : null;
}

/* ── jobs ─────────────────────────────────────────────────────────────────── */

/**
 * Payload shapes, keyed by job type.
 *
 * A job payload is `jsonb`, so nothing constrains it at the database and a handler
 * that reads `payload.url` gets `undefined` at best. `url` used to arrive as an
 * artist link — which is why a whole afternoon went into a "Deezer gateway fault"
 * that was really a fan-out request — so the shape is asserted rather than assumed.
 */
export const jobPayloadSchemas = {
	download: z.object({
		url: z.string().min(1).max(2048),
		provider: z.string().min(1).max(50).optional(),
		meta: z.record(z.string(), z.unknown()).optional(),
		retryForTrackId: z.string().uuid().optional(),
		upgradeForTrackId: z.string().uuid().optional(),
	}),
	metadata_repair: z.object({
		trackId: z.string().uuid(),
		reason: z.string().max(60).optional(),
		force: z.boolean().optional(),
	}),
	upgrade_check: z.object({ trackId: z.string().uuid() }),
	lyrics: z.object({
		trackId: z.string().uuid(),
		force: z.boolean().optional(),
		upgradeForTrackId: z.string().uuid().optional(),
	}),
	navidrome_scan: z.object({ full: z.boolean().optional() }).partial(),
} as const;

export type ValidatedJobType = keyof typeof jobPayloadSchemas;

export const JOB_TYPES: readonly ValidatedJobType[] = Object.keys(
	jobPayloadSchemas,
) as ValidatedJobType[];

/** Validate a payload for a known job type; unknown types pass through untouched. */
export function validateJobPayload(type: string, payload: unknown): unknown {
	const schema = (jobPayloadSchemas as Record<string, z.ZodTypeAny | undefined>)[type];
	if (!schema) return payload;
	const parsed = schema.safeParse(payload);
	if (!parsed.success) {
		throw new DbInvariantError(
			`Refusing to run a ${type} job with an invalid payload: ${parsed.error.issues
				.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
				.join('; ')}`,
			parsed.error.issues,
		);
	}
	return parsed.data;
}

/* ── settings ────────────────────────────────────────────────────────────── */

/** A file extension we will write into the library. Never trust a request-supplied one. */
export const libraryExtension = z
	.string()
	.regex(/^[a-z0-9]{1,5}$/, { message: 'extension must be a short lowercase token' });

/** Seconds. Guards against a negative duration reaching a tag writer. */
export const seconds = z
	.number()
	.finite()
	.min(0)
	.max(60 * 60 * 12);

/** kbps, for the quality policy. */
export const bitrateKbps = z.number().finite().min(0).max(3200);
