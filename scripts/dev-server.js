/**
 * @file dev-server.js
 * @description Development launcher: starts the Vite dev server for the renderer,
 * then spawns Electron pointed at it.
 *
 * Simpler than the upstream template's version because there is no TypeScript
 * compile step and no static-file copying — the main process is plain CommonJS
 * that Electron reads straight from `src/main`. Changes there trigger a full
 * Electron restart; changes in the renderer are handled by Vite's HMR.
 */

import Path from 'node:path';
import { fileURLToPath } from 'node:url';
import ChildProcess from 'node:child_process';
import { EOL } from 'node:os';
import * as Vite from 'vite';
import Chalk from 'chalk';
import { watch } from 'chokidar';
import Electron from 'electron';

process.env.NODE_ENV = 'development';

/** Absolute path to the project root. */
const rootDir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {import('vite').ViteDevServer|null} */
let viteServer = null;

/** @type {ChildProcess.ChildProcess|null} */
let electronProcess = null;

/** Guards against double-spawning Electron during rapid file changes. */
let electronProcessLocker = false;

/** Port the Vite dev server actually bound to. */
let rendererPort = 0;


/**
 * Boots the Vite dev server for the renderer.
 *
 * @returns {Promise<import('vite').ViteDevServer>} the listening server
 */
async function startRenderer() {

	viteServer = await Vite.createServer({
		configFile: Path.join(rootDir, 'vite.config.js'),
		mode: 'development',
	});

	return viteServer.listen();
}


/**
 * Spawns the Electron process, piping its output through with a prefix.
 *
 * @returns {void}
 */
function startElectron() {

	// single instance lock
	if (electronProcess !== null)
		return;

	const args = [
		Path.join(rootDir, 'src', 'main', 'main.cjs'),
		String(rendererPort),
	];

	electronProcess = ChildProcess.spawn(Electron, args, {
		env: { ...process.env, NODE_ENV: 'development' },
	});
	electronProcessLocker = false;

	electronProcess.stdout.on('data', (data) => {
		if (data.toString() === EOL)
			return;
		process.stdout.write(Chalk.blueBright('[electron] ') + Chalk.white(data.toString()));
	});

	electronProcess.stderr.on('data', (data) => {
		process.stderr.write(Chalk.blueBright('[electron] ') + Chalk.white(data.toString()));
	});

	electronProcess.on('exit', () => stop());
}


/**
 * Kills and respawns Electron, used when a main-process file changes.
 *
 * @returns {void}
 */
function restartElectron() {

	if (electronProcess !== null) {
		electronProcess.removeAllListeners('exit');
		electronProcess.kill();
		electronProcess = null;
	}

	if (electronProcessLocker === false) {
		electronProcessLocker = true;
		startElectron();
	}
}


/**
 * Shuts down the Vite server and exits.
 *
 * @returns {void}
 */
function stop() {

	if (viteServer !== null)
		viteServer.close();

	process.exit();
}


/**
 * Entry point.
 *
 * @returns {Promise<void>} resolves once everything is running
 */
async function start() {

	console.log(Chalk.greenBright('======================================='));
	console.log(Chalk.greenBright(' GollyGCode — starting Electron + Vite '));
	console.log(Chalk.greenBright('======================================='));

	const devServer = await startRenderer();
	rendererPort = devServer.config.server.port;

	startElectron();

	const mainPath = Path.join(rootDir, 'src', 'main');
	watch(mainPath, { cwd: mainPath, ignoreInitial: true }).on('change', (changed) => {
		console.log(Chalk.blueBright('[electron] ') + `Change in ${changed}, restarting...`);
		restartElectron();
	});
}

start();
