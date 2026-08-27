/**
 * @file eslint.config.js
 * @description Flat ESLint configuration for GollyGCode.
 *
 * Three things this file is responsible for, beyond ordinary linting:
 *
 *  1. House style — tabs for indentation, single quotes, semicolons.
 *  2. JSDoc enforcement — every file carries a header block and every exported
 *     function is documented. This is a project requirement, not a preference.
 *  3. The `src/core` fence — the CAM core must never import Vue or touch the DOM.
 *     That is what keeps it runnable in Node (so vitest can cover it headlessly)
 *     and inside a Web Worker (so code generation never blocks the UI). The rules
 *     under the `src/core/**` block below are load-bearing: if they start failing,
 *     something has leaked in that will bite later.
 */

import js from '@eslint/js';
import globals from 'globals';
import stylistic from '@stylistic/eslint-plugin';
import pluginVue from 'eslint-plugin-vue';
import jsdoc from 'eslint-plugin-jsdoc';

export default [

	// ---------------------------------------------------------------- ignores
	{
		ignores: ['node_modules/**', 'build/**', 'dist/**', 'coverage/**'],
	},

	// ------------------------------------------------------------- base rules
	js.configs.recommended,
	...pluginVue.configs['flat/recommended'],

	{
		files: ['**/*.{js,cjs,mjs,vue}'],

		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.browser,
				...globals.es2024,
			},
		},

		plugins: {
			'@stylistic': stylistic,
			jsdoc,
		},

		rules: {

			// -------------------------------------------------------- style
			'@stylistic/indent': ['error', 'tab'],
			'@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
			'@stylistic/semi': ['error', 'always'],
			'@stylistic/comma-dangle': ['error', 'always-multiline'],
			'@stylistic/eol-last': ['error', 'always'],
			'@stylistic/no-trailing-spaces': 'error',
			'@stylistic/space-before-blocks': 'error',
			'@stylistic/keyword-spacing': 'error',

			// -------------------------------------------------------- jsdoc
			'jsdoc/require-jsdoc': ['warn', {
				require: {
					FunctionDeclaration: true,
					ClassDeclaration: true,
					MethodDefinition: true,
				},
				publicOnly: false,
			}],
			'jsdoc/require-param': 'warn',
			'jsdoc/require-param-description': 'warn',
			'jsdoc/require-returns': 'warn',
			'jsdoc/require-file-overview': ['warn', {
				tags: {
					file: { initialCommentsOnly: true, mustExist: true, preventDuplicates: true },
					description: { initialCommentsOnly: true, mustExist: true, preventDuplicates: true },
				},
			}],
			'jsdoc/check-alignment': 'warn',
			'jsdoc/check-param-names': 'warn',
			'jsdoc/check-tag-names': ['warn', { definedTags: ['file'] }],

			// ------------------------------------------------------ general
			'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			'eqeqeq': ['error', 'smart'],
			'prefer-const': 'error',
			'no-var': 'error',
		},
	},

	// ------------------------------------------------- the src/core fence
	// See the file header. These rules keep the CAM core headless.
	{
		files: ['src/core/**/*.js'],

		languageOptions: {
			globals: {
				...globals.node,
			},
		},

		rules: {
			'no-restricted-imports': ['error', {
				patterns: [
					{
						group: ['vue', 'vue/*', '@vue/*'],
						message: 'src/core must stay framework-free — it runs in Node (vitest) and in a Web Worker. Move anything Vue-shaped into src/renderer.',
					},
					{
						group: ['@/*', 'vue-win-mgr', 'vue-settings-panel'],
						message: 'src/core must not depend on the application layer. Dependencies point inward only: renderer -> core, never core -> renderer.',
					},
				],
			}],

			'no-restricted-globals': ['error',
				{ name: 'document', message: 'src/core must stay DOM-free so it can run in Node and in a Web Worker.' },
				{ name: 'window', message: 'src/core must stay DOM-free so it can run in Node and in a Web Worker.' },
				{ name: 'navigator', message: 'src/core must stay DOM-free so it can run in Node and in a Web Worker.' },
				{ name: 'localStorage', message: 'src/core must stay DOM-free so it can run in Node and in a Web Worker.' },
			],
		},
	},

	// ------------------------------------------------ main process (CommonJS)
	{
		files: ['src/main/**/*.cjs', 'scripts/**/*.js'],

		languageOptions: {
			sourceType: 'commonjs',
			globals: {
				...globals.node,
			},
		},

		rules: {
			'no-restricted-globals': 'off',
		},
	},

	{
		files: ['scripts/**/*.js', '*.config.js'],
		languageOptions: {
			sourceType: 'module',
			globals: { ...globals.node },
		},
	},

	// ----------------------------------------------------------------- tests
	{
		files: ['**/*.test.js', 'tests/**/*.js'],
		languageOptions: {
			globals: { ...globals.node },
		},
		rules: {
			// tests document themselves through their names and their prose
			// comments; ceremonial @param tags on a three-line helper are noise
			'jsdoc/require-jsdoc': 'off',
			'jsdoc/require-file-overview': 'off',
			'jsdoc/require-param': 'off',
			'jsdoc/require-param-description': 'off',
			'jsdoc/require-returns': 'off',
		},
	},
];
