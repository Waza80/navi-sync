/**
 * In-memory sliding-window rate limiter.
 *
 * Phase 1 scope: single-process deployment (Node monolith), so in-memory is
 * correct. If the deployment ever scales horizontally, swap the backing store
 * for Redis (documented in docs/security.md). All /api routes are gated in
 * hooks.server.ts; Better Auth additionally rate-limits auth endpoints.
 */

type NowFn = () => number;

const buckets = new Map<string, number[]>();
const PRUNE_THRESHOLD = 5_000;

export interface RateLimitResult {
	ok: boolean;
	/** Seconds until the next request would be allowed (0 when ok). */
	retryAfterSec: number;
	remaining: number;
}

export function rateLimit(
	key: string,
	limit: number,
	windowMs: number,
	now: NowFn = Date.now,
): RateLimitResult {
	const t = now();
	if (buckets.size > PRUNE_THRESHOLD) prune(t);

	const hits = (buckets.get(key) ?? []).filter((ts) => t - ts < windowMs);
	if (hits.length >= limit) {
		const oldest = hits[0];
		if (oldest !== undefined) {
			buckets.set(key, hits);
			return {
				ok: false,
				retryAfterSec: Math.ceil((windowMs - (t - oldest)) / 1000),
				remaining: 0,
			};
		}
	}
	hits.push(t);
	buckets.set(key, hits);
	return { ok: true, retryAfterSec: 0, remaining: limit - hits.length };
}

function prune(t: number): void {
	const maxWindow = Math.max(...[600_000]); // largest window we currently use
	for (const [key, hits] of buckets) {
		const alive = hits.filter((ts) => t - ts < maxWindow);
		if (alive.length === 0) buckets.delete(key);
		else buckets.set(key, alive);
	}
}

/** Default limits per spec: 100 requests/minute per user. */
export const DEFAULT_RATE_LIMIT = 100;
export const DEFAULT_RATE_WINDOW_MS = 60_000;

/** Test helper — do not use in production code paths. */
export function __resetRateLimiter(): void {
	buckets.clear();
}
