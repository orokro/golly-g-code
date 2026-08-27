/**
 * @file main.cjs
 * @description Electron main process entry point for GollyGCode.
 *
 * This file is plain CommonJS and is copied verbatim into the packaged app — there
 * is no compile step for the main process. (The upstream template ran `tsc` here,
 * and its build script used `Promise.allSettled`, which meant a main-process
 * compile error printed "success" and packaged partial output. Removing the
 * compile step removes the whole class of bug.)
 *
 * Two decisions in here are worth understanding before changing anything:
 *
 * 1. **The `app://` scheme.** The packaged renderer is NOT loaded with `loadFile()`.
 *    A `file://` page has an opaque origin, and under an opaque origin: module
 *    workers refuse to load cross-origin, and `fetch()` cannot read `file://` at
 *    all — which breaks the standard way wasm modules are instantiated. Both
 *    failures reproduce ONLY in the packaged build, never in `npm run dev`, which
 *    is the worst possible time to discover them. Registering a real scheme with a
 *    proper origin avoids all of it.
 *
 * 2. **The Content-Security-Policy.** The upstream template set `script-src 'self'`,
 *    which blocks blob-URL workers (how Monaco spawns its language services) and
 *    refuses wasm compilation outright. The policy below is deliberately widened
 *    for exactly those two things and nothing else. It is stricter in production
 *    than in development, where Vite's HMR client needs a websocket and inline
 *    script.
 */

const { app, BrowserWindow, ipcMain, session, protocol, net, dialog } = require('electron');
const { join, relative, isAbsolute } = require('node:path');
const { pathToFileURL } = require('node:url');
const FileSystem = require('node:fs/promises');

/** True when running under `npm run dev` (see scripts/dev-server.js). */
const IS_DEV = process.env.NODE_ENV === 'development';

/** Custom scheme used to serve the packaged renderer. See the file header. */
const APP_SCHEME = 'app';

/** Host component of the app:// origin. Arbitrary, but must be a valid hostname. */
const APP_HOST = 'local';

/** Absolute path to the packaged renderer directory. Unused in development. */
const RENDERER_ROOT = join(app.getAppPath(), 'renderer');

/** @type {BrowserWindow|null} The single main window. */
let mainWindow = null;


/**
 * Registers the custom app:// scheme as privileged.
 *
 * MUST be called before the `ready` event — Electron latches the scheme registry
 * at startup. Marking it `standard` gives pages a real (non-opaque) origin;
 * `secure` puts it in a secure context so crypto/workers behave; `supportFetchAPI`
 * and `stream` let fetch() and ranged media requests work against it.
 *
 * @returns {void}
 */
function registerAppScheme() {

	protocol.registerSchemesAsPrivileged([{
		scheme: APP_SCHEME,
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			stream: true,
			corsEnabled: true,
		},
	}]);
}


/**
 * Installs the handler that serves packaged renderer files over app://.
 *
 * Requests are resolved relative to RENDERER_ROOT and validated to ensure they
 * cannot escape it — a request for `app://local/../../etc/passwd` is rejected
 * rather than served.
 *
 * @returns {void}
 */
function installAppProtocolHandler() {

	protocol.handle(APP_SCHEME, async (request) => {

		const url = new URL(request.url);

		// an empty path (app://local/) means the entry document
		const requestedPath = decodeURIComponent(url.pathname) || '/index.html';
		const target = join(RENDERER_ROOT, requestedPath);

		// reject anything that resolves outside the renderer root
		const rel = relative(RENDERER_ROOT, target);
		if (rel.startsWith('..') || isAbsolute(rel))
			return new Response('Forbidden', { status: 403 });

		try {
			return await net.fetch(pathToFileURL(target).toString());
		} catch {
			return new Response('Not Found', { status: 404 });
		}
	});
}


/**
 * Builds the Content-Security-Policy header value for the current mode.
 *
 * See the file header for why `blob:` and `'wasm-unsafe-eval'` are present.
 *
 * @param {Number} rendererPort - the Vite dev server port; ignored in production
 * @returns {String} a single CSP header value
 */
function buildContentSecurityPolicy(rendererPort) {

	// worker-src falls back through child-src to script-src when unspecified, so
	// blob: has to appear in both places for blob-URL workers to load.
	const shared = [
		'default-src \'self\'',
		'worker-src \'self\' blob:',
		'style-src \'self\' \'unsafe-inline\'',
		'img-src \'self\' data: blob:',
		'font-src \'self\' data:',
	];

	if (IS_DEV) {
		return [
			...shared,

			// Vite's HMR client injects inline script and uses eval for module updates
			'script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' \'wasm-unsafe-eval\' blob:',
			`connect-src 'self' blob: data: ws://localhost:${rendererPort} http://localhost:${rendererPort}`,
		].join('; ');
	}

	return [
		...shared,
		'script-src \'self\' \'wasm-unsafe-eval\' blob:',
		'connect-src \'self\' blob: data:',
	].join('; ');
}


/**
 * Creates the application's main window and points it at the renderer.
 *
 * @param {Number} rendererPort - the Vite dev server port; ignored in production
 * @returns {void}
 */
function createWindow(rendererPort) {

	mainWindow = new BrowserWindow({
		width: 1600,
		height: 1000,
		minWidth: 940,
		minHeight: 600,
		show: false,
		backgroundColor: '#1e1e22',
		webPreferences: {
			preload: join(__dirname, 'preload.cjs'),
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});

	// avoid the white flash while the renderer boots
	mainWindow.once('ready-to-show', () => mainWindow.show());

	mainWindow.on('closed', () => { mainWindow = null; });

	if (IS_DEV)
		mainWindow.loadURL(`http://localhost:${rendererPort}`);
	else
		mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
}


/**
 * Registers the IPC surface available to the renderer.
 *
 * Everything here uses `handle`/`invoke` (request/response) rather than the
 * template's fire-and-forget `send`, because every one of these operations needs
 * to return something. All filesystem work happens here in main, never in the
 * preload — the preload is sandboxed and cannot require('fs').
 *
 * @returns {void}
 */
function registerIpcHandlers() {

	ipcMain.handle('app:getVersion', () => app.getVersion());

	ipcMain.handle('dialog:openFile', async (_event, options) => {
		const result = await dialog.showOpenDialog(mainWindow, options ?? {});
		return result.canceled ? null : result.filePaths;
	});

	ipcMain.handle('dialog:saveFile', async (_event, options) => {
		const result = await dialog.showSaveDialog(mainWindow, options ?? {});
		return result.canceled ? null : result.filePath;
	});

	ipcMain.handle('fs:readText', async (_event, path) => {
		return await FileSystem.readFile(path, 'utf8');
	});

	ipcMain.handle('fs:readBinary', async (_event, path) => {
		const buffer = await FileSystem.readFile(path);

		// structured clone handles ArrayBuffer natively; Buffer would arrive as a
		// plain object with a `data` array, which is both slower and surprising.
		return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
	});

	ipcMain.handle('fs:writeText', async (_event, path, contents) => {
		await FileSystem.writeFile(path, contents, 'utf8');
		return true;
	});

	ipcMain.handle('fs:writeBinary', async (_event, path, contents) => {
		await FileSystem.writeFile(path, Buffer.from(contents));
		return true;
	});
}


// the scheme registry is latched at startup, so this cannot wait for whenReady()
registerAppScheme();

app.whenReady().then(() => {

	// argv[2] is the Vite port, passed by scripts/dev-server.js
	const rendererPort = Number(process.argv[2]) || 8080;

	if (!IS_DEV)
		installAppProtocolHandler();

	const csp = buildContentSecurityPolicy(rendererPort);

	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		callback({
			responseHeaders: {
				...details.responseHeaders,
				'Content-Security-Policy': [csp],
			},
		});
	});

	registerIpcHandlers();
	createWindow(rendererPort);

	// macOS: re-create a window when the dock icon is clicked with none open
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0)
			createWindow(rendererPort);
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin')
		app.quit();
});
