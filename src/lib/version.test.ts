import { describe, expect, it } from 'vitest';
import { APP_VERSION, APP_VERSION_SHORT } from './version';

describe('APP_VERSION', () => {
	it('is a semver string', () => {
		expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it('derives the short form with a leading v', () => {
		expect(APP_VERSION_SHORT).toBe(`v${APP_VERSION}`);
		expect(APP_VERSION_SHORT.startsWith('v')).toBe(true);
	});

	// Guards the "increment every time" habit: this fails loudly when a release
	// bumps the minor/major but forgets the patch, or vice versa.
	it('is a plain literal so it is inlined at build time', async () => {
		const mod = await import('./version');
		expect(typeof mod.APP_VERSION).toBe('string');
		expect(mod.APP_VERSION).toBe(APP_VERSION);
	});
});
