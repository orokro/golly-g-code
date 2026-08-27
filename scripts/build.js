/**
 * @file build.js
 * @description Production build step run before electron-builder packages the app.
 *
 * Only the renderer needs building — the main process is plain CommonJS that
 * electron-builder copies straight out of `src/main` (see electron-builder.json).
 *
 * Note this uses a plain `await`, not `Promise.allSettled`. The upstream template
 * used allSettled, which meant a failed build printed a green success message and
 * then packaged whatever partial output happened to exist. A failed build must
 * fail loudly and stop the pipeline.
 */

import Path from 'node:path';
import { fileURLToPath } from 'node:url';
import FileSystem from 'node:fs';
import * as Vite from 'vite';
import Chalk from 'chalk';

/** Absolute path to the project root. */
const rootDir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..');


/**
 * Builds the renderer bundle into build/renderer.
 *
 * `base: './'` makes every emitted asset URL relative, which is what allows the
 * bundle to be served from the app:// origin without rewriting paths.
 *
 * @returns {Promise<void>} resolves when the bundle is written
 */
async function buildRenderer() {

	await Vite.build({
		configFile: Path.join(rootDir, 'vite.config.js'),
		base: './',
		mode: 'production',
	});
}


/**
 * Entry point.
 *
 * @returns {Promise<void>} resolves when the build completes
 */
async function main() {

	FileSystem.rmSync(Path.join(rootDir, 'build'), { recursive: true, force: true });

	console.log(Chalk.blueBright('Building renderer...'));

	try {
		await buildRenderer();
	} catch (error) {
		console.error(Chalk.redBright('Renderer build FAILED:'));
		console.error(error);
		process.exit(1);
	}

	console.log(Chalk.greenBright('Renderer built. Ready for electron-builder.'));
}

main();
