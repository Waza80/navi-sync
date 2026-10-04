/**
 * Locals contract, declared structurally so neither svelte-check nor
 * eslint depends on deep inference through better-auth's generic types.
 * The hooks pipeline populates these from Better Auth's session.
 */
declare global {
	namespace App {
		interface SessionUser {
			id: string;
			name: string;
			email: string;
			emailVerified: boolean;
			role: string;
			image?: string | null;
			createdAt: Date;
			updatedAt: Date;
		}
		interface SessionInfo {
			id: string;
			userId: string;
			token: string;
			expiresAt: Date;
			ipAddress?: string | null;
			userAgent?: string | null;
		}
		interface Locals {
			user: SessionUser | null;
			session: SessionInfo | null;
		}
	}
}

export {};
