import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { providerCredentials } from '$lib/server/db/schema';
import { decryptSecret, encryptSecret } from '$lib/server/crypto';

/**
 * Per-provider configuration store. The whole config JSON (credentials,
 * instance URLs, options) is encrypted at rest with AES-256-GCM — same
 * scheme as the rest of the vault. Providers declare which fields they need
 * (see /api/providers for descriptors); values never echo back to clients.
 */

export async function getProviderConfig<T>(providerId: string): Promise<T | null> {
	const rows = await db
		.select()
		.from(providerCredentials)
		.where(eq(providerCredentials.id, providerId))
		.limit(1);
	const row = rows[0];
	if (!row) return null;
	try {
		return JSON.parse(decryptSecret(row.dataEnc)) as T;
	} catch {
		return null;
	}
}

export async function setProviderConfig(
	providerId: string,
	config: Record<string, unknown>,
): Promise<void> {
	const dataEnc = encryptSecret(JSON.stringify(config));
	await db
		.insert(providerCredentials)
		.values({ id: providerId, dataEnc })
		.onConflictDoUpdate({
			target: providerCredentials.id,
			set: { dataEnc, updatedAt: new Date() },
		});
}

export async function clearProviderConfig(providerId: string): Promise<void> {
	await db.delete(providerCredentials).where(eq(providerCredentials.id, providerId));
}
