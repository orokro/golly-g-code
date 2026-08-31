/**
 * @file projectFile.js
 * @description New, Open, Save, Save As, and not losing work on the way out.
 *
 * All of the POLICY for opening and saving lives here, in the renderer, where
 * the store and the dirty flag are. The main process is a relay: it shows the
 * native dialogs it is asked to show, reads and writes the bytes it is given,
 * and forwards a close request. That split is on purpose — logic in main.cjs
 * cannot be tested, because vitest has no Electron in it, and "did the unsaved
 * changes prompt actually appear" is exactly the thing you want a test for
 * rather than a habit of remembering to check.
 *
 * So everything below takes its Electron surface as an injected `api`, and the
 * tests drive it with a fake that records what was asked for.
 *
 * ---------------------------------------------------------------------------
 * The one rule
 *
 * Anything that replaces what is open — New, Open, Open Recent, closing the
 * window — goes through `guard()` first. There is exactly one place that asks
 * "you have unsaved changes", and every path that could destroy work is routed
 * through it. The alternative is four copies of the same three-button dialog and
 * a fifth path somebody added later that has none.
 * ---------------------------------------------------------------------------
 */

import { shallowRef, computed } from 'vue';

import { createProject } from '@core/project/document.js';
import { packProject, unpackProject, suggestedFilename, FILE_FILTER } from '@core/project/file.js';
import { prepareSvgImport, uniqueName, summarise } from '@core/project/import.js';
import { addSubtree } from '@core/project/commands.js';
import { folderOf } from '@core/project/tree.js';
import { NodeType, FolderRole, createNode } from '@core/project/nodes.js';

import { createRecentFiles } from './recentFiles.js';

/** What the user chose when asked about unsaved changes. */
export const Answer = Object.freeze({
	SAVE: 'save',
	DISCARD: 'discard',
	CANCEL: 'cancel',
});


/**
 * Wires a project store to the filesystem.
 *
 * @param {Object} options - options
 * @param {Object} options.store - a project store from `createProjectStore`
 * @param {Object} options.api - the Electron surface, `window.gollyAPI` in the app
 * @param {Object} [options.recent] - a recent-files list, injectable for tests
 * @param {Function} [options.newId] - id factory for new projects, injectable
 * @returns {Object} the file commands and the state the header renders from
 * @throws {TypeError} when there is no store or no api
 */
export function useProjectFile(options) {

	/**
	 * The last part of a path, on either kind of separator.
	 *
	 * Not `node:path`: this runs in the renderer, and the paths come from the
	 * main process, which may be reporting a Windows path to a build running
	 * anywhere. Splitting on both is simpler than caring which.
	 *
	 * @param {String} full - an absolute path
	 * @returns {String} the filename
	 */
	const basename = (full) => full.split(/[/\\]/).pop() || full;

	const { store, api, recent = createRecentFiles(), newId } = options ?? {};

	if (store === undefined || api === undefined)
		throw new TypeError('useProjectFile needs a store and an api');

	/** Where the open project lives, or null when it has never been saved. */
	const path = shallowRef(null);

	/** What the last operation went wrong with, for the status bar. */
	const lastError = shallowRef(null);

	/** The project's name, from its root node. */
	const name = computed(() => {
		store.revision.value;
		return store.document.nodes[store.document.root]?.name ?? 'Untitled';
	});

	/** What the window title should say. The bullet is the unsaved marker. */
	const title = computed(() => `${store.dirty.value ? '• ' : ''}${name.value} — GollyGCode`);

	/**
	 * Asks about unsaved changes, if there are any.
	 *
	 * Returns false only when the user said Cancel — the caller must then do
	 * nothing at all, rather than doing the thing anyway and telling them about
	 * it afterwards.
	 *
	 * @returns {Promise<Boolean>} whether it is safe to replace what is open
	 */
	async function guard() {

		if (store.dirty.value === false)
			return true;

		const answer = await api.messageBox({
			type: 'warning',
			// the destructive choice is never the default, and never the one the
			// Enter key lands on
			buttons: ['Save', "Don't save", 'Cancel'],
			defaultId: 0,
			cancelId: 2,
			message: `Save changes to ${name.value}?`,
			detail: 'Your changes will be lost if you do not save them.',
		});

		const chose = [Answer.SAVE, Answer.DISCARD, Answer.CANCEL][answer] ?? Answer.CANCEL;

		if (chose === Answer.CANCEL)
			return false;

		// a Save that is itself cancelled at the file dialog must not then go on
		// and throw the work away
		return chose === Answer.DISCARD ? true : save();
	}

	/**
	 * Starts an empty project, after checking it is safe to.
	 *
	 * @returns {Promise<Boolean>} true when a new project was started
	 */
	async function newProject() {

		if (await guard() === false)
			return false;

		store.load(createProject({ newId }));
		path.value = null;
		lastError.value = null;

		return true;
	}

	/**
	 * Opens a project.
	 *
	 * @param {String} [from] - a path; asks with a dialog when absent
	 * @returns {Promise<Boolean>} true when a project was opened
	 */
	async function open(from) {

		if (await guard() === false)
			return false;

		const chosen = from ?? await ask();

		if (chosen == null)
			return false;

		try {
			const bytes = await api.readBinary(chosen);
			const project = unpackProject(new Uint8Array(bytes));

			store.load(project);
			path.value = chosen;
			lastError.value = null;
			recent.remember(chosen, name.value);

			return true;
		}
		catch (error) {

			// the file said no. Its message is a sentence written for this moment,
			// so it is shown rather than swallowed -- and the entry is dropped from
			// the recent list, because an unopenable file is not a recent file
			lastError.value = error.message;
			recent.forget(chosen);

			await api.messageBox({
				type: 'error',
				buttons: ['OK'],
				message: 'That project could not be opened.',
				detail: error.message,
			});

			return false;
		}
	}

	/**
	 * Asks the user which file to open.
	 *
	 * @returns {Promise<String|null>} the chosen path
	 */
	async function ask() {

		const chosen = await api.openFileDialog({
			title: 'Open project',
			filters: [FILE_FILTER],
			properties: ['openFile'],
		});

		return Array.isArray(chosen) ? chosen[0] ?? null : chosen ?? null;
	}

	/**
	 * Saves to where it came from, or asks when it has never been saved.
	 *
	 * @returns {Promise<Boolean>} true when it was written
	 */
	async function save() {
		return path.value === null ? saveAs() : write(path.value);
	}

	/**
	 * Asks where to save, then saves there.
	 *
	 * @returns {Promise<Boolean>} true when it was written
	 */
	async function saveAs() {

		const chosen = await api.saveFileDialog({
			title: 'Save project',
			defaultPath: path.value ?? suggestedFilename(store.project),
			filters: [FILE_FILTER],
		});

		return chosen == null ? false : write(chosen);
	}

	/**
	 * Writes the project to a path.
	 *
	 * `markSaved` happens only after the write RESOLVES. Clearing the dirty flag
	 * first would mean a failed write leaves the app claiming there is nothing to
	 * save, which is the one state from which work actually disappears.
	 *
	 * @param {String} to - absolute path
	 * @returns {Promise<Boolean>} true when it was written
	 */
	async function write(to) {

		try {
			await api.writeBinary(to, packProject(store.project));

			store.markSaved();
			path.value = to;
			lastError.value = null;
			recent.remember(to, name.value);

			return true;
		}
		catch (error) {

			lastError.value = error.message;

			await api.messageBox({
				type: 'error',
				buttons: ['OK'],
				message: 'That project could not be saved.',
				detail: error.message,
			});

			return false;
		}
	}

	/**
	 * Imports one or more SVG files into the project.
	 *
	 * Each file is its own undo entry, because importing three drawings and
	 * wanting only two of them back is a real thing that happens, and one entry
	 * for the batch would make that impossible.
	 *
	 * The geometry and the original text are written into the project BEFORE the
	 * command is dispatched. Neither goes through the undo system — see
	 * document.js — and an import that is then undone leaves both behind on
	 * purpose, since that is exactly what its redo needs.
	 *
	 * @param {String[]} [paths] - files to import; asks with a dialog when absent
	 * @returns {Promise<Object>} `{ imported, warnings }` — how many files, and
	 *   anything the importer had to say about them
	 */
	async function importSvg(paths) {

		const chosen = paths ?? await api.openFileDialog({
			title: 'Import SVG',
			filters: [{ name: 'SVG drawings', extensions: ['svg'] }],
			properties: ['openFile', 'multiSelections'],
		});

		if (chosen == null || chosen.length === 0)
			return { imported: 0, warnings: [] };

		const folder = folderOf(store.document, FolderRole.SVGS);

		/** @type {String[]} */
		const warnings = [];
		let imported = 0;

		for (const each of chosen) {

			try {

				const text = await api.readText(each);
				const prepared = prepareSvgImport(text, {
					filename: basename(each),
					existingSources: store.project.sources,
				});

				store.project.sources[prepared.source] = text;
				Object.assign(store.project.geometry, prepared.geometry);

				const counts = summarise(prepared);

				store.dispatch(addSubtree(store.document, folder.id, prepared.nodes, {
					label: `Import ${prepared.doc.name}`,
				}));

				imported += 1;
				warnings.push(...prepared.warnings.map((w) => `${prepared.doc.name}: ${w}`));

				if (counts.total === 0)
					warnings.push(`${prepared.doc.name}: no shapes to cut.`);
			}
			catch (error) {
				warnings.push(`${basename(each)}: ${error.message}`);
			}
		}

		// A modal ONLY when nothing arrived, because then there is nothing on
		// screen to look at instead. A successful import's notes live on the
		// drawing itself, in the Inspector, next to the setting that answers the
		// commonest one of them -- a dialog you dismiss every single time is a
		// dialog you stop reading, and the resolution note fires for every file
		// that states no physical size, which is most of them.
		if (imported === 0 && warnings.length > 0)
			await api.messageBox({
				type: 'error',
				buttons: ['OK'],
				message: 'Nothing could be imported.',
				detail: warnings.slice(0, 12).join('\n'),
			});

		return { imported, warnings };
	}

	/**
	 * Imports a reference image.
	 *
	 * The bytes go into the project's asset store, which is outside the document
	 * for the same reason geometry is: undo copies what a command touched, and a
	 * photograph is not something to copy because its node was renamed.
	 *
	 * @param {String[]} [paths] - files to import; asks with a dialog when absent
	 * @returns {Promise<Number>} how many were imported
	 */
	async function importReference(paths) {

		const chosen = paths ?? await api.openFileDialog({
			title: 'Import reference image',
			filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
			properties: ['openFile', 'multiSelections'],
		});

		if (chosen == null || chosen.length === 0)
			return 0;

		const folder = folderOf(store.document, FolderRole.REFERENCES);
		let imported = 0;

		for (const each of chosen) {

			try {

				const bytes = new Uint8Array(await api.readBinary(each));
				const name = basename(each);
				const key = uniqueName(name, store.project.assets);

				store.project.assets[key] = bytes;

				store.dispatch(addSubtree(store.document, folder.id,
					[createNode(NodeType.REFERENCE_IMAGE, { name, asset: key })],
					{ label: `Import ${name}` }));

				imported += 1;
			}
			catch (error) {
				lastError.value = error.message;
			}
		}

		return imported;
	}

	/**
	 * Answers the main process's "may I close?".
	 *
	 * The same guard as everything else, which is why closing cannot be the one
	 * path that forgets to ask.
	 *
	 * @returns {Promise<Boolean>} true when the window may close
	 */
	function requestClose() {
		return guard();
	}

	return {
		path,
		name,
		title,
		lastError,
		recent: recent.files,
		newProject,
		open,
		save,
		saveAs,
		importSvg,
		importReference,
		requestClose,
		forgetRecent: recent.forget,
		clearRecent: recent.clear,
	};
}
