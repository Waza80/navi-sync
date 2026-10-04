import { providerDescriptors } from '$lib/server/providers/descriptors';
import { getProviderConfig } from '$lib/server/providers/config';
import { env } from '$lib/server/env';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
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
				configured,
				via,
				/** Non-secret echo for prefill (email / instance URL only). */
				prefill:
					d.id === 'deezer'
						? {
								email:
									(cfg as { email?: string } | null)?.email ??
									(via === 'env' ? env.DEEZER_EMAIL : '') ??
									'',
							}
						: d.id === 'monochrome'
							? {
									instanceUrl:
										(cfg as { instanceUrl?: string } | null)?.instanceUrl ?? '',
									quality:
										(cfg as { quality?: string } | null)?.quality ??
										'HI_RES_LOSSLESS',
								}
							: {},
			};
		}),
	);
	return { providers };
};
