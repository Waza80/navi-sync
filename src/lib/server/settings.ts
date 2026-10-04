import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { settings } from '$lib/server/db/schema';
import { decryptSecret, encryptSecret } from '$lib/server/crypto';

/**
 * Application settings (singleton row, id='default').
 * Navidrome password is stored AES-256-GCM encrypted and never leaves the
 * server decrypted except to talk to Navidrome itself.
 */

export interface AppSettings {
	navidromeUrl: string | null;
	navidromeUsername: string | null;
	navidromePassword: string | null; // decrypted, in-memory only
	libraryPath: string;
	minBitrateKbps: number;
	preferLossless: boolean;
	allowLowerFallback: boolean;
	/** Providers the engine may use. */
	enabledProviders: string[];
	concurrentDownloads: number;
}

const DEFAULTS = {
	libraryPath: './music',
	minBitrateKbps: 320,
	preferLossless: true,
	allowLowerFallback: true,
	enabledProviders: ['deezer', 'monochrome'] as string[],
	concurrentDownloads: 4,
};

export async function getSettings(): Promise<AppSettings> {
	const rows = await db.select().from(settings).where(eq(settings.id, 'default')).limit(1);
	let row = rows[0];
	if (!row) {
		const inserted = await db
			.insert(settings)
			.values({ id: 'default', ...DEFAULTS })
			.onConflictDoNothing()
			.returning();
		row = inserted[0];
		if (!row) {
			const again = await db
				.select()
				.from(settings)
				.where(eq(settings.id, 'default'))
				.limit(1);
			row = again[0];
			if (!row) throw new Error('settings row unavailable');
		}
	}
	return {
		navidromeUrl: row.navidromeUrl,
		navidromeUsername: row.navidromeUsername,
		navidromePassword: row.navidromePasswordEnc
			? decryptSecret(row.navidromePasswordEnc)
			: null,
		libraryPath: row.libraryPath,
		minBitrateKbps: row.minBitrateKbps,
		preferLossless: row.preferLossless,
		allowLowerFallback: row.allowLowerFallback,
		enabledProviders: Array.isArray(row.enabledProviders)
			? row.enabledProviders
			: [...DEFAULTS.enabledProviders],
		concurrentDownloads: row.concurrentDownloads,
	};
}

export interface SettingsPatch {
	navidromeUrl?: string | null;
	navidromeUsername?: string | null;
	navidromePassword?: string | null; // null = leave unchanged
	libraryPath?: string;
	minBitrateKbps?: number;
	preferLossless?: boolean;
	allowLowerFallback?: boolean;
	enabledProviders?: string[];
	concurrentDownloads?: number;
}

export async function updateSettings(patch: SettingsPatch): Promise<AppSettings> {
	await getSettings(); // ensure row exists
	const values: Record<string, unknown> = { updatedAt: new Date() };
	if (patch.navidromeUrl !== undefined) values.navidromeUrl = patch.navidromeUrl;
	if (patch.navidromeUsername !== undefined) values.navidromeUsername = patch.navidromeUsername;
	if (patch.navidromePassword !== undefined && patch.navidromePassword !== null) {
		values.navidromePasswordEnc = encryptSecret(patch.navidromePassword);
	}
	if (patch.libraryPath !== undefined) values.libraryPath = patch.libraryPath;
	if (patch.minBitrateKbps !== undefined) values.minBitrateKbps = patch.minBitrateKbps;
	if (patch.preferLossless !== undefined) values.preferLossless = patch.preferLossless;
	if (patch.allowLowerFallback !== undefined)
		values.allowLowerFallback = patch.allowLowerFallback;
	if (patch.enabledProviders !== undefined) values.enabledProviders = patch.enabledProviders;
	if (patch.concurrentDownloads !== undefined)
		values.concurrentDownloads = patch.concurrentDownloads;

	await db.update(settings).set(values).where(eq(settings.id, 'default'));
	return getSettings();
}

/** Safe projection for the UI — never contains credentials. */
export async function getPublicSettings(): Promise<{
	navidromeUrl: string | null;
	navidromeUsername: string | null;
	hasNavidromePassword: boolean;
	libraryPath: string;
	minBitrateKbps: number;
	preferLossless: boolean;
	allowLowerFallback: boolean;
	/** Providers the engine may use. */
	enabledProviders: string[];
	concurrentDownloads: number;
}> {
	const s = await getSettings();
	return {
		navidromeUrl: s.navidromeUrl,
		navidromeUsername: s.navidromeUsername,
		hasNavidromePassword: s.navidromePassword !== null,
		libraryPath: s.libraryPath,
		minBitrateKbps: s.minBitrateKbps,
		preferLossless: s.preferLossless,
		allowLowerFallback: s.allowLowerFallback,
		concurrentDownloads: s.concurrentDownloads,
		enabledProviders: s.enabledProviders,
	};
}
