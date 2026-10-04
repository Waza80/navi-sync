import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { db } from '$lib/server/db';
import { auditLog, user as usersTable } from '$lib/server/db/schema';
import { env } from '$lib/server/env';
import { logger } from '$lib/server/logger';
import { hashPassword, verifyPassword } from '$lib/server/password';
import { sql } from 'drizzle-orm';

const log = logger;

/** Audit write that must never break the auth flow. */
async function audit(entry: {
	userId?: string | null;
	event: string;
	ipAddress?: string | null;
	userAgent?: string | null;
	metadata?: Record<string, unknown>;
}): Promise<void> {
	try {
		await db.insert(auditLog).values({
			userId: entry.userId ?? null,
			event: entry.event,
			ipAddress: entry.ipAddress ?? null,
			userAgent: entry.userAgent ?? null,
			metadata: entry.metadata ?? null,
		});
	} catch (err) {
		log.error('audit log write failed', { event: entry.event, error: String(err) });
	}
}

/**
 * Better Auth instance (v1.7).
 *  - Telemetry explicitly disabled (spec: zero third-party calls).
 *  - Argon2id password hashing (spec: bcrypt/argon2 grade).
 *  - Sessions: 7 days, refreshed daily, short cookie cache for page loads.
 *  - First registered user becomes 'admin'; later signups are 'user'.
 *  - Auth events land in audit_log with IP + user agent for anomaly review.
 */
export const auth = betterAuth({
	appName: 'NaviSync',
	secret: env.APP_SECRET,
	baseURL: env.BETTER_AUTH_URL,
	basePath: '/api/auth',
	// Same-host access is always trusted (CSRF-safe: attacker origins differ
	// from the Host header); extra origins can be whitelisted via TRUSTED_ORIGINS.
	trustedOrigins: (request) => {
		const origins = [...env.TRUSTED_ORIGINS, env.BETTER_AUTH_URL];
		// Classic Vite dev port allowed outside production (testing convenience).
		if (!env.IS_PROD) {
			origins.push('http://localhost:5173', 'http://127.0.0.1:5173');
		}
		const origin = request?.headers.get('origin');
		const host = request?.headers.get('host');
		if (origin && host) {
			try {
				if (new URL(origin).host === host) origins.push(origin);
			} catch {
				// malformed origin header — ignore
			}
		}
		return origins;
	},
	telemetry: { enabled: false },
	database: drizzleAdapter(db, {
		provider: 'pg',
	}),
	emailAndPassword: {
		enabled: true,
		minPasswordLength: 10,
		requireEmailVerification: false,
	},
	password: {
		hash: (password: string) => hashPassword(password),
		verify: ({ hash, password }: { hash: string; password: string }) =>
			verifyPassword(hash, password),
	},
	user: {
		additionalFields: {
			role: { type: 'string', defaultValue: 'user', input: false },
		},
	},
	session: {
		expiresIn: 60 * 60 * 24 * 7,
		updateAge: 60 * 60 * 24,
		freshAge: 60 * 60,
		storeSessionInDatabase: true,
		cookieCache: {
			enabled: true,
			maxAge: 5 * 60,
		},
	},
	advanced: {
		cookiePrefix: 'navisync',
		useSecureCookies: env.USE_SECURE_COOKIES,
	},
	rateLimit: {
		enabled: true,
		window: 60,
		max: 30,
		storage: 'memory',
	},
	databaseHooks: {
		user: {
			create: {
				before: async (newUser) => {
					// First user on a fresh deployment becomes admin.
					const [{ count }] = await db
						.select({ count: sql<number>`count(*)::int` })
						.from(usersTable);
					const role = count === 0 ? 'admin' : 'user';
					log.info('user signup', { userId: newUser.id, isFirstUser: count === 0 });
					return { data: { ...newUser, role } };
				},
				after: async (user, ctx) => {
					await audit({
						userId: user.id,
						event: 'auth.user.created',
						ipAddress: ctx?.request ? ctx.request.headers.get('x-forwarded-for') : null,
						userAgent: ctx?.request ? ctx.request.headers.get('user-agent') : null,
					});
				},
			},
			delete: {
				after: async (user) => {
					// GDPR right to erasure marker — sessions/accounts cascade via FK.
					await audit({ userId: user.id, event: 'auth.user.deleted' });
				},
			},
		},
		session: {
			create: {
				after: async (session) => {
					await audit({
						userId: session.userId,
						event: 'auth.session.created',
						ipAddress: session.ipAddress,
						userAgent: session.userAgent,
					});
				},
			},
			delete: {
				after: async (session) => {
					await audit({
						userId: session.userId,
						event: 'auth.session.destroyed',
						ipAddress: session.ipAddress,
					});
				},
			},
		},
	},
});

export type Auth = typeof auth;
