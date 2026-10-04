import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '$lib/server/env';

/**
 * AES-256-GCM encryption for credentials at rest (Navidrome password, Deezer
 * session). Key is derived from APP_SECRET via SHA-256.
 *
 * Ciphertext format: "v1.<iv b64>.<tag b64>.<ciphertext b64>"
 * The version prefix allows future re-encryption migrations.
 */

const KEY = createHash('sha256').update(env.APP_SECRET).digest(); // 32 bytes → AES-256
const VERSION = 'v1';

export function encryptSecret(plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', KEY, iv);
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [
		VERSION,
		iv.toString('base64'),
		tag.toString('base64'),
		encrypted.toString('base64'),
	].join('.');
}

export function decryptSecret(payload: string): string {
	const [version, ivB64, tagB64, dataB64] = payload.split('.');
	if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
		throw new Error('Invalid encrypted payload format');
	}
	const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'));
	decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
	return Buffer.concat([
		decipher.update(Buffer.from(dataB64, 'base64')),
		decipher.final(),
	]).toString('utf8');
}
