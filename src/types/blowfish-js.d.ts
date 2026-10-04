declare module 'blowfish-js' {
	export interface BlowfishState {
		/** Opaque key-expanded context. */
		__brand: unique symbol;
	}
	/** Expand a key into a Blowfish context. Key: 1–56 bytes. */
	export function key(keyBytes: Buffer): BlowfishState;
	/** ECB encrypt/decrypt of a buffer whose length is a multiple of 8. */
	export function ecb(state: BlowfishState, data: Buffer, decrypt?: boolean): Buffer;
	/** CBC encrypt/decrypt of a buffer whose length is a multiple of 8. */
	export function cbc(state: BlowfishState, iv: Buffer, data: Buffer, decrypt?: boolean): Buffer;
	export function encipherBlock(state: BlowfishState, block: Buffer): Buffer;
	export function decipherBlock(state: BlowfishState, block: Buffer): Buffer;
}
