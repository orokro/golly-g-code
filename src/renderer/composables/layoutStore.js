/**
 * @file layoutStore.js
 * @description Remembering where the user put their windows.
 *
 * A window layout is fiddly to arrange and infuriating to lose, so it is saved
 * on every change. That is the whole feature, and all of the care is in three
 * details that are easy to get wrong and unpleasant to debug later.
 *
 * **Debounced, because the event fires constantly.** Dragging a splitter emits a
 * layout change on every mouse move. Writing to localStorage synchronously on
 * each one serialises the whole tree hundreds of times a second, on the main
 * thread, during the one interaction where dropped frames are most obvious.
 *
 * **Versioned, because layouts outlive the code that made them.** A layout saved
 * by an older build can reference a window slug that no longer exists. Restoring
 * it puts the app in a state the user cannot fix except by clearing site data,
 * which they have no way of knowing to do. A stored layout whose version does
 * not match is discarded, deliberately and quietly — a fresh default layout is
 * a mild annoyance, and a broken window manager is not.
 *
 * **Validated, because localStorage is a text field the user can edit.** It is
 * also shared with anything else that ever ran on this origin, and it survives
 * upgrades. Everything read back is treated as hostile until it parses.
 */

/** Bumped whenever a stored layout would no longer restore correctly. */
export const LAYOUT_VERSION = 1;

/** Where the layout lives. */
export const LAYOUT_KEY = 'gollygcode.layout';

/** How long the layout must stop changing before it is written, milliseconds. */
export const SETTLE_MS = 400;


/**
 * Creates a layout store.
 *
 * @param {Object} [options] - options
 * @param {Object} [options.storage] - a localStorage-alike; the real one by default
 * @param {Number} [options.settleMs=SETTLE_MS] - debounce window
 * @param {Function} [options.setTimer=setTimeout] - injectable for tests
 * @param {Function} [options.clearTimer=clearTimeout] - injectable for tests
 * @param {Array} [options.knownSlugs] - if given, a stored layout referencing a
 *   slug outside this list is discarded
 * @returns {Object} the store
 */
export function createLayoutStore(options = {}) {

	const {
		storage = globalThis.localStorage,
		settleMs = SETTLE_MS,
		setTimer = setTimeout,
		clearTimer = clearTimeout,
		knownSlugs = null,
	} = options;

	let timer = null;
	let pending = null;

	/**
	 * Writes now, whatever the debounce was doing.
	 *
	 * @returns {Boolean} true if something was written
	 */
	const flush = () => {

		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}

		if (pending === null || storage == null)
			return false;

		try {
			storage.setItem(LAYOUT_KEY, JSON.stringify({
				version: LAYOUT_VERSION,
				savedAt: new Date().toISOString(),
				layout: pending,
			}));
		} catch (error) {
			// a full or disabled localStorage must not take the app down; the
			// user loses a remembered layout, which is survivable
			console.warn('[layout] could not be saved', error);
			return false;
		}

		pending = null;
		return true;
	};

	return {

		/**
		 * Records a layout, to be written once changes stop.
		 *
		 * @param {Object} layout - as given by the manager's `layout-changed`
		 */
		save(layout) {

			pending = layout;

			if (timer !== null)
				clearTimer(timer);

			timer = setTimer(() => {
				timer = null;
				flush();
			}, settleMs);
		},

		flush,

		/**
		 * Reads the stored layout back, or null if there isn't a usable one.
		 *
		 * @returns {Object|null} the layout
		 */
		load() {

			if (storage == null)
				return null;

			let raw;
			try {
				raw = storage.getItem(LAYOUT_KEY);
			} catch (error) {
				console.warn('[layout] could not be read', error);
				return null;
			}

			if (raw == null)
				return null;

			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				// hand-edited, truncated, or written by something else entirely
				return null;
			}

			if (parsed?.version !== LAYOUT_VERSION || !Array.isArray(parsed.layout))
				return null;

			// A layout naming a window this build does not have would restore an
			// app the user cannot repair from inside the app.
			if (knownSlugs !== null) {
				const known = new Set(knownSlugs);
				const named = parsed.layout.flatMap((frame) => frame?.windows ?? []);
				for (const entry of named) {
					const slug = typeof entry === 'string' ? entry : entry?.kind;
					if (slug !== undefined && !known.has(slug))
						return null;
				}
			}

			return parsed.layout;
		},

		/** Forgets the stored layout, for "reset layout". */
		clear() {

			if (timer !== null) {
				clearTimer(timer);
				timer = null;
			}
			pending = null;

			try {
				storage?.removeItem(LAYOUT_KEY);
			} catch (error) {
				console.warn('[layout] could not be cleared', error);
			}
		},
	};
}
