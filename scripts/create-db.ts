import 'dotenv/config';
import { Pool, type PoolClient } from 'pg';

/**
 * Create the `navisync` database on the target PostgreSQL server when it does
 * not exist yet. Safe to re-run (42P04 duplicate_database is ignored).
 *
 * Usage: npm run db:create
 * Uses DATABASE_URL; the database name is replaced with DATABASE_NAME (default
 * `navisync`) while keeping host/credentials.
 */

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL is required. Copy .env.example to .env first.');
	process.exit(1);
}

const url = new URL(process.env.DATABASE_URL);
const targetDb = process.env.DATABASE_NAME ?? 'navisync';
const adminUrl = new URL(url.toString());
adminUrl.pathname = '/postgres';

const pool = new Pool({ connectionString: adminUrl.toString() });
let client: PoolClient | null = null;

try {
	client = await pool.connect();
	const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDb]);
	if (exists.rowCount === 0) {
		// Identifier must be injected directly (CREATE DATABASE does not accept binds).
		const safeName = targetDb.replace(/[^a-zA-Z0-9_]/g, '');
		if (safeName !== targetDb) throw new Error(`Unsafe database name: ${targetDb}`);
		await client.query(`CREATE DATABASE ${safeName}`);
		console.log(`Database "${targetDb}" created.`);
	} else {
		console.log(`Database "${targetDb}" already exists.`);
	}
} catch (err) {
	console.error('db:create failed:', err);
	process.exitCode = 1;
} finally {
	client?.release();
	await pool.end();
}
