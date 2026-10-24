/**
 * Shared HTTP for lyric sources.
 *
 * Why this exists: every source used to treat ANY non-200 as "this song has no
 * lyrics". Measured on 2026-10-21, that turned transient backend noise into
 * permanent-looking misses:
 *
 *   lrclib.net/api/search      503 on 54 of 138 calls
 *   lyrics.paxsenix.org        502/503 on 123 of 133 calls
 *
 * A 503 is not an answer. Retrying a bounded number of times, honouring
 * `Retry-After`, turns a large share of those back into lyrics — and when the
 * backend really is down, the caller still gets a definitive "no" after a
 * couple of seconds instead of hanging.
 */

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface RetryOptions {
	/** Per-attempt timeout. */
	timeoutMs?: number;
	/** Retries AFTER the first attempt (so 2 = three attempts total). */
	retries?: number;
	/** Extra headers; merged over init.headers. */
	headers?: Record<string, string>;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(res: Response | null, attempt: number): number {
	const header = res?.headers.get('retry-after');
	if (header) {
		const seconds = Number(header);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
		const at = Date.parse(header);
		if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), 5000);
	}
	return Math.min(400 * 2 ** attempt, 4000);
}

/**
 * Fetch with bounded retries. Returns the last response even when it is still
 * a 5xx (callers may want the status), or null if every attempt threw.
 */
export async function fetchWithRetry(
	url: string,
	init: RequestInit = {},
	opts: RetryOptions = {},
): Promise<Response | null> {
	const { timeoutMs = 10_000, retries = 2 } = opts;
	const headers = { ...opts.headers, ...(init.headers as Record<string, string> | undefined) };

	let last: Response | null = null;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			last = await fetch(url, {
				...init,
				headers,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			last = null;
			if (attempt === retries) return null;
			await sleep(retryDelayMs(null, attempt));
			continue;
		}
		if (!RETRYABLE.has(last.status) || attempt === retries) return last;
		await sleep(retryDelayMs(last, attempt));
	}
	return last;
}
