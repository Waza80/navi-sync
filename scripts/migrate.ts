import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
	console.error('DATABASE_URL is required. Copy .env.example to .env first.');
	process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
const out = resolve('./drizzle');
mkdirSync(out, { recursive: true });

try {
	await migrate(db, { migrationsFolder: out });
	console.log('Migrations applied.');
} finally {
	await pool.end();
}
