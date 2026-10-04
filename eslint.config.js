import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';

/**
 * NaviSync strict ESLint configuration.
 * CI gate: `npm run lint` exits non-zero on ANY warning.
 */
export default tseslint.config(
	{
		ignores: [
			'build/**',
			'.svelte-kit/**',
			'node_modules/**',
			'drizzle/**',
			'music/**',
			'scripts/**',
			'coverage/**',
			'*.config.js',
			'*.config.ts',
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	prettier,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
			},
		},
	},
	...svelte.configs['flat/recommended'],
	{
		files: ['**/*.svelte'],
		languageOptions: {
			parserOptions: {
				parser: tseslint.parser,
				projectService: true,
				extraFileExtensions: ['.svelte'],
			},
			// Browser globals are checked by svelte-check/TS, not no-undef.
			globals: {
				fetch: 'readonly',
				EventSource: 'readonly',
				window: 'readonly',
				document: 'readonly',
				console: 'readonly',
			},
		},
		rules: {
			'no-undef': 'off',
		},
	},
	// `.svelte.ts` modules (runes) are TypeScript, NOT Svelte markup —
	// the svelte plugin must not parse them.
	{
		files: ['**/*.svelte.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { projectService: true, extraFileExtensions: [] },
		},
	},
	{
		rules: {
			// Mandated quality gates (spec: "no any in TypeScript", "no warnings in CI")
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', caughtErrors: 'none' },
			],
			'@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
			'@typescript-eslint/no-unsafe-unary-minus': 'error',
			// Server logs must go through the structured logger, never console
			'no-console': 'error',
		},
	},
);
