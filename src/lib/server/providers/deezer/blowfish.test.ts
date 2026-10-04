import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { key as blowfishKey, cbc as blowfishCbc } from 'blowfish-js';
import { generateBlowfishKey } from './blowfish';

/**
 * Round-trip test for the BF_CBC_STRIPE scheme:
 * encrypt synthetic stripes with the same algorithm the downloader decrypts
 * (CBC, IV = be32(index) + zeros, every 3rd 2048-byte stripe), then assert
 * `decryptStripeFile` restores the original bytes.
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decryptStripeFile } from './blowfish';

const SECRET = 'g4el58wc0zvf9na1';

function stripeIv(_index: number): Buffer {
	// Current CDN scheme: FIXED IV per stripe (verified live 2026-10).
	return Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
}

function encryptStripe(stripe: Buffer, index: number, bfKey: Buffer): Buffer {
	const state = blowfishKey(bfKey);
	return blowfishCbc(state, stripeIv(index), stripe, false);
}

describe('generateBlowfishKey', () => {
	it('is 16 bytes and deterministic', () => {
		const a = generateBlowfishKey('3135556');
		const b = generateBlowfishKey('3135556');
		expect(a.length).toBe(16);
		expect(a.equals(b)).toBe(true);
	});
});

describe('decryptStripeFile', () => {
	it('restores encrypted stripes (indexes divisible by 3) and passes clear ones', async () => {
		const trackId = '3135556';
		const bfKey = generateBlowfishKey(trackId);

		// 5 stripes = 10240 bytes. Only stripes with index % 3 === 0 are
		// encrypted (0 and 3); 1, 2, 4 stay clear — mirroring BF_CBC_STRIPE.
		const plain = Buffer.alloc(5 * 2048);
		for (let i = 0; i < plain.length; i++) plain[i] = i % 251;
		const cipher = Buffer.alloc(plain.length);
		for (let s = 0; s < 5; s++) {
			const stripe = plain.subarray(s * 2048, (s + 1) * 2048);
			const processed = s % 3 === 0 ? encryptStripe(stripe, s, bfKey) : stripe;
			processed.copy(cipher, s * 2048);
		}

		const dir = mkdtempSync(join(tmpdir(), 'navisync-bf-'));
		const src = join(dir, 'in.raw');
		const dst = join(dir, 'out.mp3');
		writeFileSync(src, cipher);

		const result = await decryptStripeFile(src, dst, trackId);
		const decrypted = readFileSync(dst);

		expect(decrypted.equals(plain)).toBe(true);
		expect(result.bytes).toBe(plain.length);
		expect(result.sha256).toBe(createHash('sha256').update(plain).digest('hex'));
	});

	it('leaves the SECRET constant intact for interop with deemix-derived keys', () => {
		// Regression guard: key derivation must match md5(id)[i] ^ md5(id)[i+16] ^ SECRET[i]
		const id = '42';
		const h = createHash('md5').update(id).digest('hex');
		let expected = '';
		for (let i = 0; i < 16; i++) {
			expected += String.fromCharCode(
				h.charCodeAt(i) ^ h.charCodeAt(i + 16) ^ SECRET.charCodeAt(i),
			);
		}
		expect(generateBlowfishKey(id).equals(Buffer.from(expected, 'latin1'))).toBe(true);
	});
});
