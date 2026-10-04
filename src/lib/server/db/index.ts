import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';

const log = logger;

/**
 * Shared PostgreSQL pool. Migrations are applied automatically and
 * idempotently on first use (both dev and prod), so a fresh deployment
 * converges without manual steps.
 */
const globalForDb = globalThis as unknown as {
	naviSyncPool?: Pool;
	naviSyncMigrate?: Promise<void>;
};

export const pool: Pool =
	globalForDb.naviSyncPool ??
	new Pool({
		connectionString: env.DATABASE_URL,
		max: 10,
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 10_000,
	});

if (env.IS_PROD) globalForDb.naviSyncPool = pool;

export const db = drizzle(pool, { schema });

export function ensureMigrated(): Promise<void> {
	globalForDb.naviSyncMigrate ??= (async () => {
		const migrationsFolder = join(
			dirname(fileURLToPath(import.meta.url)),
			'../../../../drizzle',
		);
		if (!existsSync(migrationsFolder)) {
			log.warn('migrations folder not found, skipping auto-migrate', { migrationsFolder });
			return;
		}
		log.info('applying database migrations…');
		await migrate(db, { migrationsFolder });
		log.info('database migrations up to date');
	})().catch((err) => {
		log.error('migration failed', { error: String(err) });
		globalForDb.naviSyncMigrate = undefined;
		throw err;
	});
	return globalForDb.naviSyncMigrate;
}

export { schema };
