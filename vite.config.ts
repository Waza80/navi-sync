import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node',
		coverage: {
			provider: 'v8',
			reportsDirectory: './coverage',
			include: [
				'src/lib/shared/**',
				'src/lib/server/library/paths.ts',
				'src/lib/server/ratelimit.ts',
			],
		},
	},
});
