/**
 * @file vitest.config.js
 * @description Test runner configuration.
 *
 * Only `src/core` is covered here, and deliberately so: the CAM core is
 * framework-free and DOM-free, which means it runs headlessly in Node with no
 * environment shimming. That property is enforced by lint rules (see
 * eslint.config.js), not just by convention.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/core/**/*.test.js', 'tests/**/*.test.js'],
		coverage: {
			include: ['src/core/**/*.js'],
			exclude: ['src/core/**/*.test.js'],
		},
	},
});
