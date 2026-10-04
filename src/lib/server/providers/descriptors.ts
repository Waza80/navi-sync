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
		id: 'monochrome',
		displayName: 'Monochrome (TIDAL proxy)',
		description:
			'Downloads through a Monochrome instance you host or trust. FLAC only (Phase 2a). Basic-auth instances are supported.',
		credentialsOptional: false,
		fields: [
			{
				key: 'instanceUrl',
				label: 'Instance URL',
				type: 'text',
				required: true,
				placeholder: 'https://monochrome.example.com',
			},
			{
				key: 'sessionCookie',
				label: 'Session cookie (recommended)',
				type: 'password',
				required: false,
				placeholder: 'better-auth.session_token=…',
				help: 'Log into the instance in your browser, copy the session cookie (DevTools → Application → Cookies), paste the value here. Cloudflare blocks server-side logins, so this is the reliable path.',
			},
			{
				key: 'username',
				label: 'Email (for automatic re-login)',
				type: 'text',
				required: false,
			},
			{
				key: 'password',
				label: 'Password (for automatic re-login)',
				type: 'password',
				required: false,
				help: 'Only useful on instances without Cloudflare on /api/auth.',
			},
			{
				key: 'quality',
				label: 'Quality',
				type: 'text',
				required: false,
				placeholder: 'HI_RES_LOSSLESS',
				help: 'HI_RES_LOSSLESS (default) | LOSSLESS | LOW',
			},
		],
	},
];

export function descriptorFor(id: string): ProviderDescriptor | null {
	return providerDescriptors.find((p) => p.id === id) ?? null;
}
