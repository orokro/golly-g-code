/**
 * @file vitest.config.js
 * @description Test runner configuration.
 *
 * `src/core` is framework-free and DOM-free, so it runs headlessly in Node with
 * no environment shimming. That property is enforced by lint rules (see
 * eslint.config.js), not just by convention. Tests that DO need a DOM opt in per
 * file with an `@vitest-environment jsdom` docblock.
 *
 * `include` covers ALL of `src`, not only `src/core`. It used to stop at core,
 * and the first test written outside it did not run at all — it lint-passed, it
 * sat in the tree, and it asserted nothing. A test file that silently never runs
 * is worse than an absent one, because it reads as coverage.
 *
 * ---------------------------------------------------------------------------
 * The `resolve.dedupe` entry below is load-bearing, and its absence produces a
 * spectacularly unhelpful failure. `vue-win-mgr` is consumed as a `file:`
 * dependency, and its own node_modules contains the Vue it auto-installed as a
 * peer -- an older one than ours. Resolving the linked package from its real
 * location therefore picks up that second Vue.
 *
 * Two Vue runtimes in one process means template refs never populate, so the
 * window manager's container ref is null and it dies with
 * `Cannot read properties of null (reading 'offsetWidth')` deep inside
 * fitWindows -- nothing in that message points at the actual cause.
 *
 * vite.config.js carries the same dedupe for the app build. If you add a third
 * config, it needs it too.
 * ---------------------------------------------------------------------------
 */

import Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Absolute path to the project root (this file's directory). */
const rootDir = Path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({

	resolve: {

		// see the file header -- without this, a second Vue breaks provide/inject
		dedupe: ['vue'],

		alias: {
			'@': Path.join(rootDir, 'src', 'renderer'),
			'@core': Path.join(rootDir, 'src', 'core'),
		},
	},

	test: {
		environment: 'node',
		include: ['src/**/*.test.js', 'tests/**/*.test.js'],
		coverage: {
			include: ['src/core/**/*.js', 'src/renderer/**/*.js'],
			exclude: ['**/*.test.js'],
		},
	},
});
