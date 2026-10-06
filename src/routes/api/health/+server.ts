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
	// Report the REAL version. This was a hardcoded '0.1.0' that had never tracked
	// a release, which made it worse than useless: I sat polling it to detect a
	// deploy for fourteen minutes while it cheerfully reported the same string it
	// would have reported if nothing had deployed at all.
	const { APP_VERSION } = await import('$lib/version');
	const body = {
		status: dbOk ? 'ok' : 'degraded',
		db: dbOk,
		uptimeSec: Math.round(process.uptime()),
		version: APP_VERSION,
	};
	return json(body, { status: dbOk ? 200 : 503 });
};
