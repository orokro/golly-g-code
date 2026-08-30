/**
 * @file recentFiles.js
 * @description The recently-opened list, remembered between runs.
 *
 * A factory rather than a module-level list, so a test can hand it a fake
 * storage and so two windows would not share one — the same reason the project
 * store is a factory.
 *
 * What comes back out of storage is UNTRUSTED. It survived an upgrade, and a
 * user can edit it. Every entry is checked and anything that does not look like
 * an entry is dropped rather than passed on to become a broken menu item — the
 * same rule as `reconcile` in useWindowState and as loading a `.gollyg`.
 */

import { shallowRef } from 'vue';

/** Where the list lives. */
export const RECENT_KEY = 'gollygcode.recent';

/** How many to keep. Long enough to be useful, short enough to read at a glance. */
export const RECENT_LIMIT = 10;


/**
 * @typedef {Object} RecentFile
 * @property {String} path - absolute path on disk
 * @property {String} name - the project's name when it was last opened
 * @property {Number} at - when, as a timestamp
 */


/**
 * Keeps whatever survives of a stored list.
 *
 * @param {*} raw - what came out of storage
 * @returns {RecentFile[]} the usable entries, newest first
 */
export function readRecent(raw) {

	if (Array.isArray(raw) === false)
		return [];

	return raw
		.filter((entry) => entry !== null
			&& typeof entry === 'object'
			&& typeof entry.path === 'string' && entry.path !== ''
			&& typeof entry.name === 'string'
			&& Number.isFinite(entry.at))
		.slice(0, RECENT_LIMIT)
		.map((entry) => ({ path: entry.path, name: entry.name, at: entry.at }));
}


/**
 * Puts a file at the top of a list, without duplicating it.
 *
 * Reopening something already in the list moves it up rather than adding a
 * second copy of it, which is what every other application does and what makes
 * the list stay short on its own.
 *
 * @param {RecentFile[]} list - the current list
 * @param {RecentFile} entry - the file just opened or saved
 * @returns {RecentFile[]} the new list, newest first
 */
export function promote(list, entry) {
	return [entry, ...list.filter((old) => old.path !== entry.path)].slice(0, RECENT_LIMIT);
}


/**
 * Creates the recent-files list.
 *
 * @param {Object} [options] - options
 * @param {Object} [options.storage] - a `localStorage`-shaped thing, injectable
 * @param {Function} [options.now=Date.now] - the clock, injectable
 * @returns {Object} the list and the things you can do to it
 */
export function createRecentFiles(options = {}) {

	const { storage = globalThis.localStorage, now = Date.now } = options;

	/** @type {import('vue').ShallowRef<RecentFile[]>} */
	const files = shallowRef(load());

	/**
	 * Reads the stored list, surviving anything that is in there.
	 *
	 * @returns {RecentFile[]} the entries
	 */
	function load() {

		try {
			return readRecent(JSON.parse(storage?.getItem(RECENT_KEY) ?? 'null'));
		}
		catch {
			// a corrupt list is not worth interrupting the user over: the worst
			// case is an empty File menu, and it repairs itself on the next save
			return [];
		}
	}

	/** Writes the list back, ignoring a storage that will not have it. */
	function persist() {

		try {
			storage?.setItem(RECENT_KEY, JSON.stringify(files.value));
		}
		catch {
			// private browsing, a full quota, a locked-down profile. None of them
			// are reasons to stop the user working
		}
	}

	/**
	 * Records that a file was just opened or saved.
	 *
	 * @param {String} path - absolute path on disk
	 * @param {String} name - the project's name
	 */
	function remember(path, name) {
		files.value = promote(files.value, { path, name, at: now() });
		persist();
	}

	/**
	 * Drops a file — because it would not open, most likely.
	 *
	 * @param {String} path - the path to forget
	 */
	function forget(path) {
		files.value = files.value.filter((entry) => entry.path !== path);
		persist();
	}

	/** Empties the list. */
	function clear() {
		files.value = [];
		persist();
	}

	return { files, remember, forget, clear };
}
