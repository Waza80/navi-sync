import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id password hashing (spec requirement). Better Auth delegates
 * hashing/verification to these functions via its `password` option.
 */
export async function hashPassword(password: string): Promise<string> {
	return hash(password, {
		memoryCost: 19456, // 19 MiB — OWASP recommended baseline
		timeCost: 2,
		parallelism: 1,
	});
}

export async function verifyPassword(hashStr: string, password: string): Promise<boolean> {
	try {
		return await verify(hashStr, password);
	} catch {
		return false;
	}
}
