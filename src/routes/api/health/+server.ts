import { json } from '@sveltejs/kit';
import { pool } from '$lib/server/db';
import type { RequestHandler } from './$types';

/** Container healthcheck: DB connectivity + process uptime. */
export const GET: RequestHandler = async () => {
	let dbOk = false;
	try {
		await pool.query('SELECT 1');
		dbOk = true;
	} catch {
		dbOk = false;
	}
	const body = {
		status: dbOk ? 'ok' : 'degraded',
		db: dbOk,
		uptimeSec: Math.round(process.uptime()),
		version: '0.1.0',
	};
	return json(body, { status: dbOk ? 200 : 503 });
};
