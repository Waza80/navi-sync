import { building } from '$app/environment';
import type { Handle } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';
import { rateLimit, DEFAULT_RATE_LIMIT, DEFAULT_RATE_WINDOW_MS } from '$lib/server/ratelimit';
import { getClientIp, sameOriginOk } from '$lib/server/api';
import { ensureWorkerStarted } from '$lib/server/queue/worker';

const log = logger;

/**
 * Request pipeline:
 *   1. Better Auth session resolution → locals.user/session
 *   2. /api/auth/* handled by Better Auth (has its own rate limiting)
 *   3. Worker bootstrap (idempotent, first request after boot)
 *   4. API guards: CSRF-style origin check + per-user rate limit (10k/min)
 *   5. Security headers on every response
 */
export const handle: Handle = async ({ event, resolve }) => {
	// Session (also serves Better Auth route handling below).
	const session = await auth.api.getSession({ headers: event.request.headers }).catch(() => null);
	event.locals.session = session?.session ?? null;
	event.locals.user = session?.user ?? null;

	const path = event.url.pathname;

	if (path.startsWith('/api/auth')) {
		if (building) return resolve(event);
		// Canonicalize the auth request to the configured origin so Better Auth
		// matches regardless of how the browser reached us (localhost, LAN IP,
		// hostname, https upgrade). Cookies remain host-scoped in the browser.
		const canonical = new URL(env.BETTER_AUTH_URL);
		const url = new URL(event.request.url);
		url.protocol = canonical.protocol;
		url.host = canonical.host;
		const rewritten = new Request(url, event.request);
		return auth.handler(rewritten);
	}

	if (!building) {
		// Start the job engine on first non-auth request (idempotent).
		ensureWorkerStarted();

		if (path.startsWith('/api/')) {
			// Origin check for mutations (CSRF defense-in-depth; SvelteKit also
			// enforces content-type checks on its own form handling).
			if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
				if (!sameOriginOk(event.request)) {
					log.warn('blocked cross-origin mutation', {
						path,
						ip: getClientIp(event.request),
					});
					return new Response(
						JSON.stringify({
							error: { code: 'FORBIDDEN', message: 'Cross-origin request rejected.' },
						}),
						{ status: 403, headers: { 'content-type': 'application/json' } },
					);
				}
			}
			// Rate limiting (skip health + long-lived SSE stream).
			const limited =
				!path.startsWith('/api/health') &&
				!path.startsWith('/api/events') &&
				!path.startsWith('/api/auth');
			if (limited) {
				const key = `${event.locals.user?.id ?? 'anon'}:${getClientIp(event.request)}`;
				const verdict = rateLimit(key, DEFAULT_RATE_LIMIT, DEFAULT_RATE_WINDOW_MS);
				if (!verdict.ok) {
					return new Response(
						JSON.stringify({
							error: {
								code: 'RATE_LIMITED',
								message: `Rate limit exceeded. Retry in ${verdict.retryAfterSec}s.`,
							},
						}),
						{
							status: 429,
							headers: {
								'content-type': 'application/json',
								'retry-after': String(Math.max(1, verdict.retryAfterSec)),
							},
						},
					);
				}
			}
		}
	}

	const response = await resolve(event);

	// Security headers (spec: CSRF/XSS protections on by default).
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'no-referrer');
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	response.headers.set(
		'Permissions-Policy',
		'camera=(), microphone=(), geolocation=(), payment=()',
	);
	if (env.USE_SECURE_COOKIES) {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}

	return response;
};
