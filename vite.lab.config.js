/**
 * @file vite.lab.config.js
 * @description Vite configuration for the "lab" — a plain browser harness for
 * visual geometry prototyping, served by `npm run lab`.
 *
 * The lab exists because geometry bugs (offsets, self-intersection cleanup, arc
 * fitting) are far easier to diagnose by looking at a rendered SVG than by reading
 * an assertion failure. Lab pages import directly from `src/core` and render their
 * output as inline SVG. Nothing here ships in the application.
 */

import Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** Absolute path to the project root (this file's directory). */
const rootDir = Path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({

	root: Path.join(rootDir, 'lab'),

	resolve: {
		alias: {
			'@core': Path.join(rootDir, 'src', 'core'),
		},
	},

	server: {
		port: 8081,
		open: false,
	},
});
