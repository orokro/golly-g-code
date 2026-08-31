/**
 * @file programFile.js
 * @description Exporting the program to a file the machine can be handed.
 *
 * Separate from `projectFile.js`, which is about the `.gollyg` document. This is
 * about the artefact — the thing that leaves the application and goes to a
 * sender, where nothing in here can correct it afterwards.
 *
 * The policy lives in the renderer for the same reason it does over there: the
 * Electron surface is injected, so the interesting question — *does Export
 * actually refuse when the text is stale?* — is a test rather than a habit of
 * remembering to check.
 *
 * ---------------------------------------------------------------------------
 * What it refuses, and why refusing is the feature
 *
 * Export is blocked whenever the text does not describe the document on screen:
 * a regeneration queued or running, a diagnostic that blocks export, or a
 * generator that threw. The user's mental model is "save what I am looking at",
 * and the gap between the two is measured in the milliseconds after a keystroke
 * — small, easy to hit by pressing a key and reaching for the toolbar, and
 * invisible when it happens, because a G-code file for the wrong version of a
 * part looks exactly like one for the right version.
 * ---------------------------------------------------------------------------
 */

import { shallowRef } from 'vue';

/** What an exported program is called, and what it is offered as. */
export const GCODE_FILTER = Object.freeze({
	name: 'G-code', extensions: ['nc', 'gcode', 'ngc', 'tap'],
});

/** The extension used when the project name has none. */
export const DEFAULT_EXTENSION = 'nc';


/**
 * The filename to offer for a project.
 *
 * @param {Object} document - the project document
 * @returns {String} a filename with an extension
 */
export function suggestedProgramName(document) {

	const name = document?.nodes?.[document.root]?.name ?? 'program';
	const safe = String(name).replace(/[\\/:*?"<>|]/g, '').trim();

	return `${safe === '' ? 'program' : safe}.${DEFAULT_EXTENSION}`;
}


/**
 * Export, and the reasons it might not happen.
 *
 * @param {Object} options - options
 * @param {Object} options.store - a project store
 * @param {Object} options.program - what `useProgram` returned
 * @param {Object} options.api - the Electron surface
 * @returns {Object} `{ exporting, lastPath, error, exportProgram }`
 */
export function useProgramFile(options) {

	const { store, program, api } = options ?? {};

	if (store === undefined || program === undefined || api === undefined)
		throw new TypeError('useProgramFile needs a store, a program and an api');

	/** True while the write is in flight, so the button can say so. */
	const exporting = shallowRef(false);

	/** Where the last export went, for the status bar. */
	const lastPath = shallowRef(null);

	/** Why the last export did not happen, or null. */
	const error = shallowRef(null);

	/**
	 * Writes the program to a file the user picks.
	 *
	 * @returns {Promise<Boolean>} true when a file was written
	 */
	async function exportProgram() {

		error.value = null;

		if (program.blocked.value.length > 0) {
			error.value = 'This project cannot be cut yet. Fix the errors in the outliner first.';
			return false;
		}

		if (program.stale.value) {
			error.value = 'The program is still being generated. Try again in a moment.';
			return false;
		}

		if (program.text.value === '') {
			error.value = 'There is nothing to export yet.';
			return false;
		}

		// captured BEFORE the dialog, which the user may leave open for a minute
		// while editing in another window -- what gets written is what was on
		// screen when they asked, or nothing
		const text = program.text.value;
		const revision = store.revision.value;

		const chosen = await api.saveFileDialog({
			title: 'Export G-code',
			defaultPath: suggestedProgramName(store.document),
			filters: [GCODE_FILTER],
		});

		if (chosen == null)
			return false;

		if (store.revision.value !== revision) {
			error.value = 'The project changed while the dialog was open, so nothing was written.';
			return false;
		}

		exporting.value = true;

		try {
			await api.writeText(chosen, text);
			lastPath.value = chosen;
			return true;
		}
		catch (thrown) {
			error.value = thrown.message;
			return false;
		}
		finally {
			exporting.value = false;
		}
	}

	return { exporting, lastPath, error, exportProgram };
}
