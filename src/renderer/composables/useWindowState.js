/**
 * @file useWindowState.js
 * @description Letting a window remember its own state across a layout save.
 *
 * The layout store remembers where each frame sits. It knows nothing about what
 * is inside them — the Workspace's zoom and pan, the 3D view's camera, where the
 * code editor was scrolled to. Restoring a layout and finding every view reset
 * to its default is the sort of thing that feels broken without being broken.
 *
 * `vue-win-mgr` provides `onSerialize` / `onLayoutLoad` for this. What it cannot
 * do is decide whether what comes back is trustworthy, and that is the whole
 * substance of this module.
 *
 * ## Restored state is untrusted input
 *
 * It arrives from localStorage. That means it has survived upgrades, it may have
 * been written by a build that thought about these fields differently, and a
 * user can edit it by hand. A saved `zoom` of `"1"` instead of `1` multiplies
 * into a string; a saved `NaN` propagates through every transform it touches; a
 * missing field becomes `undefined` and then `NaN` at the first arithmetic.
 *
 * None of those throw. They produce a view that is blank or wildly wrong, with
 * the cause several layers away from the symptom.
 *
 * So a restored value is only accepted when it is the same TYPE as the default
 * it replaces, and numbers must additionally be finite. Anything else falls back
 * to the default silently and deliberately: a view at its default zoom is a
 * complete non-event, and it is the correct response to a field we cannot make
 * sense of.
 */

import { reactive, toRaw } from 'vue';
import { onSerialize, onLayoutLoad } from 'vue-win-mgr';

/**
 * Merges saved state over defaults, keeping only values that make sense.
 *
 * Pure and exported so the rule can be tested directly. The defaults define both
 * the shape and the expected types — a field absent from them is a field this
 * build does not know about, and is dropped rather than carried along.
 *
 * @param {Object} saved - whatever came back from the layout
 * @param {Object} defaults - this window's default state
 * @returns {Object} a new object, safe to hand to a view
 */
export function reconcile(saved, defaults) {

	const out = { ...defaults };

	if (saved === null || typeof saved !== 'object' || Array.isArray(saved))
		return out;

	for (const [key, fallback] of Object.entries(defaults)) {

		if (!Object.hasOwn(saved, key))
			continue;

		const value = saved[key];

		// a field whose type changed between builds, or was hand-edited
		if (typeof value !== typeof fallback)
			continue;

		// NaN and Infinity are the ones that do damage quietly: they survive
		// every arithmetic operation and surface as a blank view much later
		if (typeof value === 'number' && !Number.isFinite(value))
			continue;

		// arrays and objects are compared by shape only as far as "is it still
		// the same kind of thing"; deeper validation belongs to whoever owns
		// the field, not here
		if (Array.isArray(fallback) !== Array.isArray(value))
			continue;

		out[key] = value;
	}

	return out;
}


/**
 * Reactive per-window state that survives a layout save.
 *
 * @param {Object} defaults - the state's shape and its default values. Must be
 *   JSON-safe: it goes into the serialized layout
 * @param {Object} [options] - options
 * @param {Function} [options.register=onSerialize] - injectable for tests
 * @param {Function} [options.restore=onLayoutLoad] - injectable for tests
 * @returns {Object} a reactive object, pre-filled with the defaults and updated
 *   in place when a saved layout arrives
 */
export function useWindowState(defaults, options = {}) {

	const {
		register = onSerialize,
		restore = onLayoutLoad,
	} = options;

	const state = reactive({ ...defaults });

	// toRaw, because a reactive proxy is not JSON-safe in every engine and the
	// layout has to serialise cleanly
	register(() => ({ ...toRaw(state) }));

	restore((saved) => {
		Object.assign(state, reconcile(saved, defaults));
	});

	return state;
}
