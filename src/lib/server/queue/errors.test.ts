import { describe, expect, it } from 'vitest';
import { describeSignature, errorSignature } from './errors';

/**
 * Forty jobs failing the same way must read as ONE problem. These pin the
 * normalisation that makes that true — and, just as importantly, that a signed
 * CDN URL is not carried into a diagnostics panel.
 */
describe('errorSignature', () => {
	it('collapses ids so per-row failures group together', () => {
		const a = errorSignature('Track 12345 not found on provider deezer');
		const b = errorSignature('Track 98761 not found on provider deezer');
		expect(a).toBe(b);
	});

	it('collapses hex digests', () => {
		expect(errorSignature('checksum mismatch e1110f5345ef8e65838c2671f2995bc')).toBe(
			errorSignature('checksum mismatch 99999a5345ef8e65838c2671f2995bc'),
		);
	});

	it('redacts a signed stream URL — it is a credential, not a diagnostic', () => {
		// Deezer's CDN URLs embed an expiry and an HMAC. Two occurrences of the same
		// failure never share one, so keeping them defeats grouping AND leaks a live
		// access token into a diagnostics endpoint.
		const sig = errorSignature(
			'download failed https://f-cdnt-stream.dzcdn.net/media/1/9/2/4.flac?hdnea=exp=1792410378~acl=*&hmac=c2814abfeb65d76dac6bbc2d76b52be799a678',
		);
		// The VALUE is the secret; the parameter name is not, and keeping it is what
		// makes the shape recognisable.
		expect(sig).not.toContain('c2814abfeb65d76dac6bbc2d76b52be799a678');
		expect(sig).not.toContain('1792410378');
		expect(sig).toMatch(/hdnea=VALUE/);
		expect(sig).toMatch(/hmac=VALUE/);
	});

	it('normalises whitespace and an empty message', () => {
		expect(errorSignature('  two   lines\n\there ')).toBe('two lines here');
		expect(errorSignature(null)).toBe('(no message)');
		expect(errorSignature('')).toBe('(no message)');
	});

	it('keeps distinct failures distinct', () => {
		const refused = errorSignature('Track token has no sufficient rights on requested media');
		const missing = errorSignature('Downloaded audio failed integrity check — short stream');
		const auth = errorSignature('Deezer rejected credentials: invalid login');
		expect(new Set([refused, missing, auth]).size).toBe(3);
	});

	it('bounds the length', () => {
		expect(errorSignature('x'.repeat(500)).length).toBeLessThanOrEqual(200);
	});
});

describe('describeSignature', () => {
	it('leaves a short signature alone', () => {
		expect(describeSignature('short enough')).toBe('short enough');
	});
	it('truncates a long one with an ellipsis', () => {
		const out = describeSignature('y'.repeat(400));
		expect(out.length).toBeLessThanOrEqual(120);
		expect(out.endsWith('…')).toBe(true);
	});
});
