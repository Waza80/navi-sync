import { subscribeNaviEvents } from '$lib/server/pg-events';
import { requireUser } from '$lib/server/api';
import type { RequestHandler } from './$types';

/**
 * Server-Sent Events stream of `navi_events` NOTIFY payloads.
 * Zero polling: Postgres NOTIFY → this stream → browser EventSource.
 */
export const GET: RequestHandler = ({ locals, request }) => {
	const unauthorized = requireUser(locals);
	if (unauthorized) return unauthorized;

	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (line: string) => {
				try {
					controller.enqueue(encoder.encode(line));
				} catch {
					// client gone — cleanup happens via abort signal
				}
			};
			send('retry: 3000\n\n');
			send(`event: hello\ndata: {"type":"hello","ts":"${new Date().toISOString()}"}\n\n`);

			void subscribeNaviEvents((payload) => send(`data: ${payload}\n\n`)).then((unsub) => {
				unsubscribe = unsub;
			});

			heartbeat = setInterval(() => send(': heartbeat\n\n'), 25_000);
			heartbeat.unref?.();

			request.signal.addEventListener('abort', () => {
				if (heartbeat) clearInterval(heartbeat);
				unsubscribe?.();
				try {
					controller.close();
				} catch {
					// already closed
				}
			});
		},
		cancel() {
			if (heartbeat) clearInterval(heartbeat);
			unsubscribe?.();
		},
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no',
		},
	});
};
