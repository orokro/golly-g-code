/**
 * @file vite.config.js
 * @description Vite configuration for the GollyGCode renderer (the Vue application).
 *
 * The renderer is the only part of the app Vite builds. The Electron main and
 * preload scripts are plain CommonJS and are copied verbatim by the build script,
 * so there is no TypeScript compile step anywhere in this project.
 *
 * Note the `resolve.dedupe` entry: `vue-win-mgr` is consumed as a `file:` dependency,
 * which npm installs as a symlink. Without deduping, Vite can resolve two separate
 * copies of Vue (one for the app, one for the linked library) which breaks
 * provide/inject and every other cross-component Vue mechanism.
 */

import Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vuePlugin from '@vitejs/plugin-vue';

/** Absolute path to the project root (this file's directory). */
const rootDir = Path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({

	// the renderer lives in its own subtree; index.html is its entry point
	root: Path.join(rootDir, 'src', 'renderer'),

	// static assets copied verbatim into the build output
	publicDir: Path.join(rootDir, 'src', 'renderer', 'public'),

	resolve: {

		// see the file header: prevents a duplicate Vue instance via the symlinked lib
		dedupe: ['vue'],

		alias: {
			'@': Path.join(rootDir, 'src', 'renderer'),
			'@core': Path.join(rootDir, 'src', 'core'),
		},
	},

	server: {
		port: 8080,

		// NOTE: this belongs inside `server`. The upstream template had it at the
		// config root, where Vite silently ignored it.
		open: false,
	},

	build: {
		outDir: Path.join(rootDir, 'build', 'renderer'),
		emptyOutDir: true,

		// classic (iife) workers, not module workers. Module workers are subject to
		// stricter origin rules; iife keeps the packaged app working under app://.
		target: 'esnext',
	},

	worker: {
		format: 'iife',
	},

	plugins: [vuePlugin()],
});
