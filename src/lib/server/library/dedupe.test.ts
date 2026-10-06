import { describe, expect, it } from 'vitest';
import { isDuplicateContent, targetExists } from './dedupe';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('isDuplicateContent', () => {
	it('treats an identical checksum as proof of duplication', () => {
		const d = isDuplicateContent({ checksumSha256: SHA_A }, [
			{ filePath: '/m/A.flac', checksumSha256: SHA_A },
		]);
		expect(d.duplicate).toBe(true);
		expect(d.reason).toBe('same-checksum');
		expect(d.against?.filePath).toBe('/m/A.flac');
	});

	it('says so even when the title differs', () => {
		// The same audio re-titled is still the same recording. Matching on title
		// would let this through as a new song.
		const d = isDuplicateContent({ checksumSha256: SHA_A, title: 'Renamed' }, [
			{ filePath: '/m/A.flac', checksumSha256: SHA_A, title: 'Original' },
		]);
		expect(d.duplicate).toBe(true);
		expect(d.reason).toBe('same-checksum');
	});

	it('accepts a genuinely different checksum', () => {
		expect(
			isDuplicateContent({ checksumSha256: SHA_B }, [
				{ filePath: '/m/A.flac', checksumSha256: SHA_A },
			]),
		).toEqual({
			duplicate: false,
			reason: 'distinct',
		});
	});

	it('falls back to size AND duration only when no checksum exists', () => {
		const d = isDuplicateContent({ sizeBytes: 1000, durationSec: 120.0 }, [
			{ filePath: '/m/A.flac', sizeBytes: 1000, durationSec: 120.1 },
		]);
		expect(d.duplicate).toBe(true);
		expect(d.reason).toBe('same-size-and-duration');
	});

	it('needs BOTH size and duration to agree', () => {
		expect(
			isDuplicateContent({ sizeBytes: 1000, durationSec: 120 }, [
				{ sizeBytes: 1000, durationSec: 200 },
			]).duplicate,
		).toBe(false);
		expect(
			isDuplicateContent({ sizeBytes: 1000, durationSec: 120 }, [
				{ sizeBytes: 999, durationSec: 120 },
			]).duplicate,
		).toBe(false);
	});

	it('tolerates encoder drift but not a different take', () => {
		expect(
			isDuplicateContent({ sizeBytes: 10, durationSec: 120.0 }, [
				{ sizeBytes: 10, durationSec: 120.9 },
			]).duplicate,
		).toBe(true);
		expect(
			isDuplicateContent({ sizeBytes: 10, durationSec: 120.0 }, [
				{ sizeBytes: 10, durationSec: 125.0 },
			]).duplicate,
		).toBe(false);
	});

	it('does not refuse a remix as a duplicate of the original', () => {
		// Same length to within a second is the only way these get confused.
		const d = isDuplicateContent({ title: 'POCKET ROCKET', durationSec: 180.0 }, [
			{ filePath: '/m/Remix.flac', title: 'POCKET ROCKET (Remix)', durationSec: 180.4 },
		]);
		expect(d.duplicate).toBe(false);
	});

	it('cannot conclude anything with no evidence at all', () => {
		expect(isDuplicateContent({}, [{ filePath: '/m/A.flac' }]).duplicate).toBe(false);
		expect(isDuplicateContent({}, [{}]).duplicate).toBe(false);
	});
});

describe('targetExists', () => {
	it('reports an occupied destination', () => {
		expect(targetExists('/m/01 - X.flac', (p) => p === '/m/01 - X.flac')).toBe(true);
	});

	it('reports a free destination', () => {
		expect(targetExists('/m/01 - Y.flac', (p) => p === '/m/01 - X.flac')).toBe(false);
	});
});
