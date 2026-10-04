import 'dotenv/config';
import { Pool } from 'pg';

/**
 * Development seed (NO-OP unless SEED_PASSWORD is explicitly set):
 *  - ensures the settings singleton row
 *  - prints guidance for creating the first user via the UI
 *
 * We deliberately do NOT create users here: Better Auth hashes passwords with
 * Argon2id internally and the first user must become admin through the
 * databaseHook — sign up through /login instead.
 */

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL is required.');
	process.exit(1);
}

if (!process.env.DATABASE_URL.includes('navisync')) {
	console.error('Refusing to seed a database not named "navisync" (safety guard).');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
	await pool.query(`INSERT INTO settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING`);
	console.log('Settings row ensured.');
	console.log('Now open http://localhost:7158/login → "Create account".');
	console.log('The FIRST account automatically becomes admin (see docs/security.md).');
} finally {
	await pool.end();
}
