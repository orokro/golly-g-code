/**
 * @file preload.cjs
 * @description Context bridge between the Electron main process and the renderer.
 *
 * This script runs sandboxed (see `sandbox: true` in main.cjs), which means it
 * cannot `require('fs')` or any other Node builtin beyond a small polyfilled set.
 * That is intentional: every privileged operation is implemented in main and
 * reached from here through `ipcRenderer.invoke`. This file should stay a thin,
 * boring list of forwarders with no logic in it.
 *
 * Anything added here must also be added to the type hints in
 * src/renderer/typings/electron.d.js, which is maintained by hand.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gollyAPI', {

	/**
	 * Returns the running application version.
	 *
	 * @returns {Promise<String>} the version string from package.json
	 */
	getVersion: () => ipcRenderer.invoke('app:getVersion'),

	/**
	 * Shows a native message box.
	 *
	 * @param {Object} options - Electron MessageBoxOptions
	 * @returns {Promise<Number>} index of the button the user pressed
	 */
	messageBox: (options) => ipcRenderer.invoke('dialog:message', options),

	/**
	 * Registers the renderer's answer to "may the window close?".
	 *
	 * The only push channel in this file. Main cannot decide whether there is
	 * unsaved work — the store is over here — so it asks, and the renderer
	 * replies with `confirmClose`.
	 *
	 * @param {Function} handler - called with no arguments when a close is attempted
	 * @returns {Function} call it to stop listening
	 */
	onCloseRequested: (handler) => {
		const listener = () => handler();
		ipcRenderer.on('app:closeRequested', listener);
		return () => ipcRenderer.removeListener('app:closeRequested', listener);
	},

	/**
	 * Answers a close request.
	 *
	 * @param {Boolean} mayClose - true to let the window close
	 * @returns {Promise<Boolean>} what main did with it
	 */
	confirmClose: (mayClose) => ipcRenderer.invoke('app:confirmClose', mayClose),

	/**
	 * Shows a native open-file dialog.
	 *
	 * @param {Object} options - Electron OpenDialogOptions
	 * @returns {Promise<String[]|null>} chosen paths, or null if cancelled
	 */
	openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),

	/**
	 * Shows a native save-file dialog.
	 *
	 * @param {Object} options - Electron SaveDialogOptions
	 * @returns {Promise<String|null>} chosen path, or null if cancelled
	 */
	saveFileDialog: (options) => ipcRenderer.invoke('dialog:saveFile', options),

	/**
	 * Reads a UTF-8 text file from disk.
	 *
	 * @param {String} path - absolute path to read
	 * @returns {Promise<String>} the file contents
	 */
	readText: (path) => ipcRenderer.invoke('fs:readText', path),

	/**
	 * Reads a binary file from disk.
	 *
	 * @param {String} path - absolute path to read
	 * @returns {Promise<ArrayBuffer>} the file contents
	 */
	readBinary: (path) => ipcRenderer.invoke('fs:readBinary', path),

	/**
	 * Writes a UTF-8 text file to disk, overwriting if it exists.
	 *
	 * @param {String} path - absolute path to write
	 * @param {String} contents - text to write
	 * @returns {Promise<Boolean>} true on success
	 */
	writeText: (path, contents) => ipcRenderer.invoke('fs:writeText', path, contents),

	/**
	 * Writes a binary file to disk, overwriting if it exists.
	 *
	 * @param {String} path - absolute path to write
	 * @param {ArrayBuffer|Uint8Array} contents - bytes to write
	 * @returns {Promise<Boolean>} true on success
	 */
	writeBinary: (path, contents) => ipcRenderer.invoke('fs:writeBinary', path, contents),
});
