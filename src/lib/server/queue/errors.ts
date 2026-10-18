/**
 * Collapse a job's error text to a SHAPE, so forty failures that are one
 * problem read as one row.
 *
 * Built for the failure that had no surface at all: an app down for ten days,
 * with a queue that reported "0 active" the entire time. Grouping errors by their
 * volatile parts — ids, hex digests, signed-URL tokens, byte counts, timings — is
 * what turns "eight dead jobs" into "one thing is broken eight times".
 */

/**
 * Volatile fragments, each replaced with a placeholder.
 *
 * Order matters and runs top to bottom. The query-parameter rule comes FIRST:
 * a signed URL has to be caught whole, before the long-token rule can chop its
 * value in half and leave the credential's key sitting next to a placeholder.
 */
const VOLATILE: Array<[RegExp, string]> = [
	// Every `key=value` in a URL query string, not just the ones that look like
	// credentials. Deezer's CDN signs with `hdnea`, `acl`, `hmac` — none of which
	// contain the substring "token" or "key", so a credential-shaped allowlist
	// would have let the actual signing parameters straight through.
	[/\b([a-zA-Z_][a-zA-Z0-9_]*)=([^\s&,"';]*)/g, '$1=VALUE'],
	[/\b[a-z0-9]{16,}\b/gi, 'ID'],
	[/\b[0-9a-f]{8,}\b/gi, 'HASH'],
	[/\b\d+\b/g, 'N'],
];

/** The stable part of an error message: same problem, same text. */
export function errorSignature(message: string | null | undefined, limit = 200): string {
	const text = (message ?? '').replace(/\s+/g, ' ').trim();
	if (text.length === 0) return '(no message)';
	let out = text.slice(0, limit);
	for (const [pattern, replacement] of VOLATILE) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

/** Human-facing label for a group of same-shaped failures. */
export function describeSignature(signature: string): string {
	// Keep it short enough for a panel; the raw text stays in the job row.
	return signature.length <= 120 ? signature : `${signature.slice(0, 117)}…`;
}
