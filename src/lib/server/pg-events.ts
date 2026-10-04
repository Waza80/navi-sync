import pg from 'pg';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';

/**
 * PostgreSQL LISTEN client with fan-out.
 *
 * Channels:
 *  - `navi_events`: job progress/completion events → SSE fan-out to browsers.
 *  - `navi_jobs`:   new/retry job wakeups  → queue worker pump.
 *
 * One dedicated connection per process. Reconnects with backoff. Web →
 * engine communication uses NOTIFY only (ADR-0002), so this module is the
 * seam that stays when a Rust engine replaces the in-process worker.
 */

const log = logger;

export type PgEventListener = (channel: string, payload: string) => void;

const globalForListen = globalThis as unknown as {
	naviListener?: { client: pg.Client; listeners: Set<PgEventListener>; onWakeup?: () => void };
	naviListenerStarting?: Promise<void>;
};

async function ensureListener(): Promise<void> {
	if (globalForListen.naviListener) return;
	if (globalForListen.naviListenerStarting) return globalForListen.naviListenerStarting;

	globalForListen.naviListenerStarting = (async () => {
		const client = new pg.Client({ connectionString: env.DATABASE_URL });
		client.on('notification', (msg) => {
			const state = globalForListen.naviListener;
			if (!state || !msg.channel) return;
			if (msg.channel === 'navi_jobs') {
				state.onWakeup?.();
			} else {
				const payload = msg.payload ?? '{}';
				for (const fn of state.listeners) {
					try {
						fn(msg.channel, payload);
					} catch (err) {
						log.error('listener callback failed', { error: String(err) });
					}
				}
			}
		});
		client.on('error', (err) => {
			log.error('pg LISTEN client error', { error: String(err) });
			teardownListener();
			setTimeout(() => {
				ensureListener().catch((e) =>
					log.error('pg LISTEN reconnect failed', { error: String(e) }),
				);
			}, 3000);
		});
		await client.connect();
		await client.query('LISTEN navi_events');
		await client.query('LISTEN navi_jobs');
		globalForListen.naviListener = { client, listeners: new Set() };
		log.info('pg LISTEN active on navi_events + navi_jobs');
	})();

	try {
		await globalForListen.naviListenerStarting;
	} finally {
		globalForListen.naviListenerStarting = undefined;
	}
}

function teardownListener(): void {
	const state = globalForListen.naviListener;
	globalForListen.naviListener = undefined;
	void state?.client.end().catch(() => undefined);
}

/** Subscribe to `navi_events` payloads. Returns an unsubscribe function. */
export async function subscribeNaviEvents(fn: (payload: string) => void): Promise<() => void> {
	await ensureListener();
	const state = globalForListen.naviListener;
	const wrapped: PgEventListener = (channel, payload) => {
		if (channel === 'navi_events') fn(payload);
	};
	state?.listeners.add(wrapped);
	return () => {
		state?.listeners.delete(wrapped);
	};
}

/** Register the queue-worker wakeup callback for `navi_jobs`. */
export async function setJobWakeupHandler(fn: () => void): Promise<void> {
	await ensureListener();
	const state = globalForListen.naviListener;
	if (state) state.onWakeup = fn;
}
