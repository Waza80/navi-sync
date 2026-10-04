import { config } from 'dotenv';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

config({ quiet: true, override: true });

function required(name: string): string {
	const value = process.env[name];
	if (!value || value.trim().length === 0) {
		throw new Error(
			`Missing required environment variable "${name}". Copy .env.example to .env and configure it.`,
		);
	}
	return value.trim();
}

function optional(name: string): string | undefined {
	const value = process.env[name];
	if (!value || value.trim().length === 0) return undefined;
	return value.trim();
}

const APP_SECRET = required('APP_SECRET');
if (APP_SECRET.length < 32) {
	// Fail fast: this secret signs sessions and encrypts stored credentials.
	throw new Error('APP_SECRET must be at least 32 characters. Generate: openssl rand -hex 32');
}

const PORT = Number.parseInt(optional('PORT') ?? '7158', 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
	throw new Error(`PORT must be an integer in [1, 65535], got: ${optional('PORT')}`);
}

const libraryDir = resolve(optional('MUSIC_LIBRARY_DIR') ?? './music');
const tmpDir = resolve(optional('MUSIC_TMP_DIR') ?? './.tmp');
mkdirSync(libraryDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

/**
 * Different .env loaders handle quoting differently (Bun strips single
 * quotes, node --env-file may keep them). Normalize credential values by
 * removing one layer of surrounding quotes regardless of runtime.
 */
function unquote(value: string | undefined): string | undefined {
	if (!value) return value;
	if (
		(value.startsWith("'") && value.endsWith("'")) ||
		(value.startsWith('"') && value.endsWith('"'))
	) {
		return value.slice(1, -1);
	}
	return value;
}

export const env = {
	DATABASE_URL: required('DATABASE_URL'),
	APP_SECRET,
	PORT,
	HOST: optional('HOST') ?? '0.0.0.0',
	BETTER_AUTH_URL: optional('BETTER_AUTH_URL') ?? `http://localhost:${PORT}`,
	TRUSTED_ORIGINS: (optional('TRUSTED_ORIGINS') ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s.length > 0),
	MUSIC_LIBRARY_DIR: libraryDir,
	MUSIC_TMP_DIR: tmpDir,
	LOG_LEVEL: (optional('LOG_LEVEL') ?? 'info').toLowerCase(),
	USE_SECURE_COOKIES: (optional('USE_SECURE_COOKIES') ?? 'false') === 'true',
	DEEZER_EMAIL: unquote(optional('DEEZER_EMAIL')),
	DEEZER_PASSWORD: unquote(optional('DEEZER_PASSWORD')),
	DEEZER_RESOLVER_URL: unquote(optional('DEEZER_RESOLVER_URL')),
	IS_PROD: process.env.NODE_ENV === 'production',
} as const;

export type AppEnv = typeof env;
