import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { key as blowfishKey, cbc as blowfishCbc } from 'blowfish-js';

/**
 * Deezer stream decryption (BF_CBC_STRIPE), ported from the public deemix /
 * echo-deezer-extension algorithm:
 *
 *   - key = 16 chars derived from md5(trackId) via the fixed XOR scheme below
 *   - the file is cut into 2048-byte stripes; every stripe with an index
 *     divisible by 3 is Blowfish-CBC encrypted with IV = be32(index) + zeros;
 *     all other stripes are clear.
 *
 * Isolated in this module because the underlying pure-JS cipher is GPL-2.0 —
 * swapping it out later must not require touching any other code.
 */

const STRIPE_SIZE = 2048;
const BLOWFISH_KEY_SECRET = 'g4el58wc0zvf9na1';

export function generateBlowfishKey(trackId: string): Buffer {
	const h = createHash('md5').update(trackId).digest('hex');
	let key = '';
	for (let i = 0; i < 16; i++) {
		key += String.fromCharCode(
			h.charCodeAt(i) ^ h.charCodeAt(i + 16) ^ BLOWFISH_KEY_SECRET.charCodeAt(i),
		);
	}
	return Buffer.from(key, 'latin1');
}

/**
 * Decrypt `srcPath` → `destPath` in constant memory. Returns sha256 of the
 * DECRYPTED output (integrity basis for the library copy).
 */
export async function decryptStripeFile(
	srcPath: string,
	destPath: string,
	trackId: string,
	signal?: AbortSignal,
): Promise<{ bytes: number; sha256: string }> {
	const bfKey = generateBlowfishKey(trackId);
	const state = blowfishKey(bfKey);

	const input = createReadStream(srcPath);
	const output = createWriteStream(destPath);
	if (signal) {
		if (signal.aborted) input.destroy(new Error('aborted'));
		signal.addEventListener('abort', () => input.destroy(new Error('aborted')), { once: true });
	}

	const hash = createHash('sha256');
	let stripeIndex = 0;
	let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);

	await pipeline(
		input,
		async function* (source) {
			for await (const chunk of source) {
				let buf: Buffer<ArrayBufferLike> =
					carry.length > 0 ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
				const out: Buffer<ArrayBufferLike>[] = [];
				while (buf.length >= STRIPE_SIZE) {
					const stripe = buf.subarray(0, STRIPE_SIZE);
					buf = buf.subarray(STRIPE_SIZE);
					if (stripeIndex % 3 === 0) {
						out.push(decryptStripe(stripe, stripeIndex, state));
					} else {
						out.push(stripe);
					}
					stripeIndex++;
				}
				carry = buf; // partial stripe stays pending for the next chunk
				if (out.length > 0) {
					const merged = Buffer.concat(out);
					hash.update(merged);
					yield merged;
				}
			}
			// Tail: shorter than a stripe. Decrypt only if fully 8-byte aligned
			// (a truncated encrypted tail cannot be decrypted meaningfully).
			if (carry.length > 0 && stripeIndex % 3 === 0 && carry.length % 8 === 0) {
				const tail = decryptStripe(carry, stripeIndex, state);
				hash.update(tail);
				yield tail;
			} else if (carry.length > 0) {
				hash.update(carry);
				yield carry;
			}
		},
		output,
	);

	return { bytes: output.bytesWritten, sha256: hash.digest('hex') };
}

function decryptStripe(
	stripe: Buffer,
	index: number,
	state: ReturnType<typeof blowfishKey>,
): Buffer {
	// Current CDN scheme (verified against live streams, 2026-10): every
	// encrypted stripe uses the FIXED CBC IV 0001020304050607. The old deemix
	// per-stripe IV (be32(index)) no longer applies.
	void index;
	const iv = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
	return blowfishCbc(state, iv, stripe, true);
}
