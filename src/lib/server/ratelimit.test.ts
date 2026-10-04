import { afterEach, describe, expect, it } from 'vitest';
import { rateLimit, __resetRateLimiter } from './ratelimit';

afterEach(() => __resetRateLimiter());

describe('rateLimit', () => {
	it('allows requests under the limit and blocks beyond it', () => {
		const t = 0;
		const now = () => t;
		for (let i = 0; i < 100; i++) {
			expect(rateLimit('u1', 100, 60_000, now).ok).toBe(true);
		}
		const blocked = rateLimit('u1', 100, 60_000, now);
		expect(blocked.ok).toBe(false);
		expect(blocked.retryAfterSec).toBeGreaterThan(0);
	});

	it('keys are independent per user', () => {
		const t = 0;
		const now = () => t;
		for (let i = 0; i < 100; i++) rateLimit('a', 100, 60_000, now);
		expect(rateLimit('b', 100, 60_000, now).ok).toBe(true);
	});

	it('window slides — old hits expire', () => {
		let t = 0;
		const now = () => t;
		for (let i = 0; i < 100; i++) rateLimit('u', 100, 60_000, now);
		expect(rateLimit('u', 100, 60_000, now).ok).toBe(false);
		t = 61_000; // beyond window
		expect(rateLimit('u', 100, 60_000, now).ok).toBe(true);
	});
});
