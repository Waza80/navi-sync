import { json } from '@sveltejs/kit';
import type { Session, User } from 'better-auth';

export interface AuthedContext {
	user: User;
	session: Session;
}

/** Returns null when authenticated, otherwise a 401 Response. */
export function requireUser(locals: App.Locals): Response | null {
	if (!locals.user || !locals.session) {
		return json(
			{ error: { code: 'UNAUTHENTICATED', message: 'Sign in required.' } },
			{ status: 401 },
		);
	}
	return null;
}

/** Plain 401 for direct `if (!locals.user)` narrowing style. */
export function unauthorizedResponse(): Response {
	return json(
		{ error: { code: 'UNAUTHENTICATED', message: 'Sign in required.' } },
		{ status: 401 },
	);
}

/** Best-effort client IP extraction (proxy-aware, GDPR: treat as personal data). */
export function getClientIp(request: Request): string {
	const fwd = request.headers.get('x-forwarded-for');
	if (fwd) {
		const first = fwd.split(',')[0];
		if (first) return first.trim();
	}
	return request.headers.get('x-real-ip') ?? 'local';
}

export function sameOriginOk(request: Request): boolean {
	const origin = request.headers.get('origin');
	if (!origin) return true; // non-browser clients (curl, scripts) — session cookie still required
	const host = request.headers.get('host');
	if (!host) return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

export function badRequest(message: string, code = 'BAD_REQUEST'): Response {
	return json({ error: { code, message } }, { status: 400 });
}

export function notFound(message = 'Not found'): Response {
	return json({ error: { code: 'NOT_FOUND', message } }, { status: 404 });
}

export function serverError(message = 'Internal error', code = 'INTERNAL'): Response {
	return json({ error: { code, message } }, { status: 500 });
}

export { json };
