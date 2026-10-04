/**
 * Provider capability descriptors — single source of truth for the Providers
 * UI (which fields to render) and the API (which shapes to accept).
 * Secrets never echo back: descriptors describe inputs only.
 */

export interface ProviderFieldDescriptor {
	key: string;
	label: string;
	type: 'text' | 'password';
	required: boolean;
	placeholder?: string;
	help?: string;
}

export interface ProviderDescriptor {
	id: string;
	displayName: string;
	description: string;
	fields: ProviderFieldDescriptor[];
	/** True when the pipeline can run without any credentials. */
	credentialsOptional: boolean;
}

export const providerDescriptors: ProviderDescriptor[] = [
	{
		id: 'deezer',
		displayName: 'Deezer',
		description:
			'Full-quality streams (FLAC/MP3 320) using your own Deezer account. Credentials are used once to derive an encrypted session — the password itself is not required after login, but keeping it allows automatic re-login when the session expires.',
		credentialsOptional: false,
		fields: [
			{
				key: 'email',
				label: 'Email',
				type: 'text',
				required: true,
				placeholder: 'you@example.com',
			},
			{
				key: 'password',
				label: 'Password',
				type: 'password',
				required: false,
				placeholder: '••••••••',
				help: 'Stored encrypted; used only to refresh the session.',
			},
			{
				key: 'arl',
				label: 'ARL cookie (alternative)',
				type: 'password',
				required: false,
				placeholder: 'paste ARL instead of email/password',
				help: 'Advanced: paste your deezer.com `arl` cookie to skip the password flow entirely.',
			},
		],
	},
	{
		id: 'tidal',
		displayName: 'Tidal (hiFi instance)',
		description:
			'Lossless FLAC from a self-hosted hiFi instance (hifi-api). The instance owns the Tidal account, so no Tidal credentials are needed here — only the instance URL. Serves up to 24-bit/192 kHz and is the fastest option by a wide margin.',
		credentialsOptional: false,
		fields: [
			{
				key: 'instanceUrl',
				label: 'Instance URL',
				type: 'text',
				required: true,
				placeholder: 'https://hifi.example.com',
				help: 'Base URL of your hifi-api deployment. Must be reachable from this server.',
			},
			{
				key: 'quality',
				label: 'Quality ceiling',
				type: 'text',
				required: false,
				placeholder: 'HI_RES_LOSSLESS',
				help: 'HI_RES_LOSSLESS (default, up to 24/192) | LOSSLESS | LOW. Lower values fall back automatically when a release has no hi-res master.',
			},
		],
	},
];

export function descriptorFor(id: string): ProviderDescriptor | null {
	return providerDescriptors.find((p) => p.id === id) ?? null;
}
