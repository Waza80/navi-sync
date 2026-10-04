import { z } from 'zod';
import { json, badRequest, notFound, unauthorizedResponse } from '$lib/server/api';
import { descriptorFor } from '$lib/server/providers/descriptors';
import {
	setProviderConfig,
	clearProviderConfig,
	getProviderConfig,
} from '$lib/server/providers/config';
import { getDeezerSession, clearInMemorySession } from '$lib/server/providers/deezer/gateway';
import { TidalClient } from '$lib/server/providers/tidal/client';
import { env } from '$lib/server/env';
import type { RequestHandler } from './$types';

const schemas = {
	deezer: z
		.object({
			email: z.string().email().max(200).optional(),
			password: z.string().min(1).max(200).optional(),
			arl: z.string().min(32).max(500).optional(),
		})
		.refine((v) => v.arl || (v.email && v.password), {
			message: 'Provide an ARL, or email + password.',
		}),
	tidal: z.object({
		instanceUrl: z.string().url().max(300),
		quality: z.enum(['HI_RES_LOSSLESS', 'LOSSLESS', 'LOW']).optional(),
	}),
} as const;

/**
 * PUT /api/providers/:id/credentials — save (encrypted) + live test.
 * A failed test keeps the stored config but returns the error so the UI can
 * surface it next to the Save button.
 */
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) return unauthorizedResponse();
	const user = locals.user;
	const id = params.id ?? '';
	const descriptor = descriptorFor(id);
	if (!descriptor) return notFound('Unknown provider');

	const raw: unknown = await request.json().catch(() => null);
	const schema = schemas[id as keyof typeof schemas];
	if (!schema) return notFound('No credential schema for provider');
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		return badRequest(
			`Invalid credentials: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
			'INVALID_CREDENTIALS',
		);
	}

	if (id === 'deezer') {
		// Merge with existing config so a password-only update keeps the email.
		const existing = (await getProviderConfig<Record<string, unknown>>('deezer')) ?? {};
		const merged = { ...existing, ...parsed.data };
		// An ARL makes email/password unnecessary; keep them if provided anyway.
		await setProviderConfig('deezer', merged);
		clearInMemorySession();
		try {
			const session = await getDeezerSession();
			return json({ ok: true, tested: true, detail: `Signed in as user ${session.userId}` });
		} catch (err) {
			return json(
				{
					ok: false,
					tested: true,
					error: `Saved, but session test failed: ${err instanceof Error ? err.message : String(err)}`,
				},
				{ status: 502 },
			);
		}
	}

	if (id === 'tidal') {
		const data = parsed.data as {
			instanceUrl: string;
			quality?: 'HI_RES_LOSSLESS' | 'LOSSLESS' | 'LOW';
		};
		const cfg = {
			instanceUrl: data.instanceUrl,
			quality: data.quality ?? 'HI_RES_LOSSLESS',
		};
		await setProviderConfig('tidal', cfg);
		const client = new TidalClient(cfg);
		try {
			const probe = await client.search('test');
			return json({
				ok: true,
				tested: true,
				detail: `Instance reachable — search returned ${probe.length} results`,
			});
		} catch (err) {
			return json(
				{
					ok: false,
					tested: true,
					error: `Saved, but instance test failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				},
				{ status: 502 },
			);
		}
	}

	void user;
	void env;
	return notFound('Unknown provider');
};

/** DELETE /api/providers/:id/credentials — remove stored config. */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return unauthorizedResponse();
	const id = params.id ?? '';
	if (!descriptorFor(id)) return notFound('Unknown provider');
	await clearProviderConfig(id);
	if (id === 'deezer') clearInMemorySession();
	return json({ ok: true, cleared: id });
};
