import { z } from 'zod';
import { json, badRequest, unauthorizedResponse } from '$lib/server/api';
import { getPublicSettings, updateSettings } from '$lib/server/settings';
import { logger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

const log = logger;

/** GET /api/navidrome — current config (never includes the password). */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return unauthorizedResponse();
	return json(await getPublicSettings());
};

const patchSchema = z.object({
	navidromeUrl: z.string().url().max(500).nullable().optional(),
	navidromeUsername: z.string().max(200).nullable().optional(),
	navidromePassword: z.string().min(1).max(500).nullable().optional(),
	libraryPath: z.string().max(500).optional(),
	minBitrateKbps: z.coerce.number().int().min(64).max(1411).optional(),
	preferLossless: z.boolean().optional(),
	allowLowerFallback: z.boolean().optional(),
	autoUpgradeQuality: z.boolean().optional(),
	enabledProviders: z
		.array(z.enum(['deezer', 'tidal']))
		.max(2)
		.optional(),
	concurrentDownloads: z.coerce.number().int().min(1).max(8).optional(),
});

/** PUT /api/navidrome — update settings; password stored AES-256-GCM encrypted. */
export const PUT: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) return unauthorizedResponse();
	const user = locals.user;
	const parsed = patchSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return badRequest(
			`Invalid settings payload: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
			'INVALID_BODY',
		);
	}
	if (parsed.data.navidromeUrl) {
		try {
			const u = new URL(parsed.data.navidromeUrl);
			if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
		} catch {
			return badRequest('navidromeUrl must be a valid http(s) URL', 'INVALID_URL');
		}
	}
	await updateSettings(parsed.data);
	if (parsed.data.navidromePassword) log.info('navidrome credentials updated', { by: user.id });
	const pub = await getPublicSettings();
	return json({ ok: true, settings: pub });
};
