import { relations } from 'drizzle-orm';
import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core';

/* ────────────────────────────────────────────────────────────────────────────
 * Better Auth core tables (v1.7 — keep names/columns aligned with its adapter)
 * ──────────────────────────────────────────────────────────────────────────── */

export const user = pgTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: boolean('email_verified').notNull().default(false),
	image: text('image'),
	/** NaviSync extension: 'admin' (first user) | 'user'. Not client-writable. */
	role: text('role').notNull().default('user'),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
	'session',
	{
		id: text('id').primaryKey(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		token: text('token').notNull().unique(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index('session_user_idx').on(t.userId)],
);

export const account = pgTable(
	'account',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id').notNull(),
		providerId: text('provider_id').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		accessToken: text('access_token'),
		refreshToken: text('refresh_token'),
		idToken: text('id_token'),
		accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
		refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
		scope: text('scope'),
		password: text('password'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index('account_user_idx').on(t.userId)],
);

export const verification = pgTable('verification', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ────────────────────────────────────────────────────────────────────────────
 * NaviSync application tables
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A physical track in the library. One row per provider track (deduplicated).
 * Quality fields are verified via music-metadata probing, not provider claims.
 */
export const tracks = pgTable(
	'tracks',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		provider: text('provider').notNull(),
		providerTrackId: text('provider_track_id'),
		sourceUrl: text('source_url'),
		title: text('title').notNull(),
		artist: text('artist').notNull(),
		album: text('album'),
		albumArtist: text('album_artist'),
		isrc: text('isrc'),
		trackNumber: integer('track_number'),
		discNumber: integer('disc_number'),
		releaseYear: integer('release_year'),
		genre: text('genre'),
		durationSec: integer('duration_sec'),
		format: text('format').notNull(), // 'mp3' | 'flac'
		bitrateKbps: integer('bitrate_kbps'),
		bitDepth: integer('bit_depth'),
		sampleRateHz: integer('sample_rate_hz'),
		isLossless: boolean('is_lossless').notNull().default(false),
		sizeBytes: bigint('size_bytes', { mode: 'number' }),
		checksumSha256: text('checksum_sha256'),
		filePath: text('file_path'),
		coverPath: text('cover_path'),
		/** 'none' | 'synced' | 'plain' | 'failed' */
		lyricsStatus: text('lyrics_status').notNull().default('none'),
		/** 'completed' | 'failed' | 'pending' — failed rows are visible in the
		 * library (no file) and auto-retried by the sweep. */
		downloadStatus: text('download_status').notNull().default('completed'),
		navidromeSyncedAt: timestamp('navidrome_synced_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex('tracks_provider_track_uq').on(t.provider, t.providerTrackId),
		index('tracks_isrc_idx').on(t.isrc),
		index('tracks_artist_idx').on(t.artist),
		index('tracks_created_idx').on(t.createdAt),
	],
);

/**
 * PostgreSQL-backed job queue. Workers claim with
 * `FOR UPDATE SKIP LOCKED`; wakeups travel over the `navi_jobs` NOTIFY
 * channel; progress events broadcast on `navi_events`. This table is the ONLY
 * contract between the web layer and any future external engine process.
 */
export const jobs = pgTable(
	'jobs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		/** 'download' | 'lyrics' | 'navidrome_scan' | 'export' */
		type: text('type').notNull(),
		/** 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'cancelled' */
		status: text('status').notNull().default('queued'),
		priority: integer('priority').notNull().default(5),
		payload: jsonb('payload').notNull().default({}),
		progress: smallint('progress').notNull().default(0),
		stage: text('stage'),
		result: jsonb('result'),
		error: text('error'),
		attempts: integer('attempts').notNull().default(0),
		maxAttempts: integer('max_attempts').notNull().default(3),
		runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
		startedAt: timestamp('started_at', { withTimezone: true }),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		trackId: uuid('track_id').references(() => tracks.id, { onDelete: 'set null' }),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index('jobs_claim_idx').on(t.status, t.priority, t.runAfter),
		index('jobs_created_idx').on(t.createdAt),
	],
);

/** Singleton row (id='default'): application settings. Secrets are encrypted. */
export const settings = pgTable('settings', {
	id: text('id').primaryKey().default('default'),
	navidromeUrl: text('navidrome_url'),
	navidromeUsername: text('navidrome_username'),
	/** AES-256-GCM encrypted (see lib/server/crypto.ts) */
	navidromePasswordEnc: text('navidrome_password_enc'),
	libraryPath: text('library_path').notNull().default('./music'),
	minBitrateKbps: integer('min_bitrate_kbps').notNull().default(320),
	preferLossless: boolean('prefer_lossless').notNull().default(true),
	/** Allow accepting a lower quality when the preferred tier is unavailable */
	allowLowerFallback: boolean('allow_lower_fallback').notNull().default(true),
	/** Providers the engine may use (search, downloads, upgrades). */
	enabledProviders: jsonb('enabled_providers').$type<string[]>().notNull().default(['deezer', 'monochrome']),
	concurrentDownloads: integer('concurrent_downloads').notNull().default(4),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Provider sessions (e.g. Deezer ARL) encrypted at rest. One row per provider.
 * The DB is the only place a credential ever lives outside memory.
 */
export const providerCredentials = pgTable('provider_credentials', {
	id: text('id').primaryKey(), // provider id, e.g. 'deezer'
	dataEnc: text('data_enc').notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Audit log for auth-relevant events. GDPR note: contains IP addresses —
 * retention/cleanup policy documented in docs/security.md.
 */
export const auditLog = pgTable(
	'audit_log',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: text('user_id'),
		event: text('event').notNull(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		metadata: jsonb('metadata'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		index('audit_user_idx').on(t.userId, t.createdAt),
		index('audit_event_idx').on(t.event, t.createdAt),
	],
);

/* ── Relations ─────────────────────────────────────────────────────────────── */

export const tracksRelations = relations(tracks, ({ many }) => ({
	jobs: many(jobs),
}));

export const jobsRelations = relations(jobs, ({ one }) => ({
	track: one(tracks, { fields: [jobs.trackId], references: [tracks.id] }),
}));
