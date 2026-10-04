import { json, unauthorizedResponse } from '$lib/server/api';
import { providerDescriptors } from '$lib/server/providers/descriptors';
import { getProviderConfig } from '$lib/server/providers/config';
import { env } from '$lib/server/env';
import type { RequestHandler } from './$types';

/**
 * GET /api/providers — capability + configuration status per provider.
 * Never returns secret values; `configured` and `via` only.
 */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return unauthorizedResponse();

	const providers = await Promise.all(
		providerDescriptors.map(async (d) => {
			const cfg =
				d.id === 'deezer'
					? await getProviderConfig<{ email?: string; arl?: string }>('deezer')
					: await getProviderConfig<Record<string, unknown>>(d.id);
			let configured = Boolean(cfg && Object.keys(cfg).length > 0);
			let via: 'ui' | 'env' | null = configured ? 'ui' : null;
			if (d.id === 'deezer' && !configured && env.DEEZER_EMAIL && env.DEEZER_PASSWORD) {
				configured = true;
				via = 'env';
			}
			return {
				id: d.id,
				displayName: d.displayName,
				description: d.description,
				fields: d.fields,
				credentialsOptional: d.credentialsOptional,
				configured,
				via,
			};
		}),
	);
	return json({ providers });
};
