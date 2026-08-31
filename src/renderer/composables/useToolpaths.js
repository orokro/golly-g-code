/**
 * @file useToolpaths.js
 * @description Keeping the toolpaths in step with the document.
 *
 * ---------------------------------------------------------------------------
 * Async on the outside, synchronous on the inside
 *
 * The interface is a promise and a state that goes `generating` and back,
 * because Phase 5 moves this into a Web Worker and everything that consumes it
 * should already be written for that. The implementation is a straight call —
 * for a drawing of a few hundred segments it is well under a frame, and a worker
 * for that would be ceremony.
 *
 * Shaping the interface first is the cheap half. Retrofitting async later means
 * touching every caller, and a caller written against a synchronous answer tends
 * to be written in a way that assumes one.
 * ---------------------------------------------------------------------------
 *
 * Regeneration is driven by command commits — the store bumps `revision` once
 * per dispatch, and coalescing already collapses a drag into one command. The
 * debounce below is for the coalesced case, where a slider being dragged still
 * publishes on every step: the entry is one, but the value keeps changing, and
 * regenerating forty times to show the fortieth is work nobody sees.
 */

import { shallowRef, watch, onScopeDispose } from 'vue';

import { generateAll } from '@core/project/toolpaths.js';

/** How long to wait for a drag to settle before regenerating. */
export const SETTLE_MS = 60;

/** What the generator is doing, for the status bar. */
export const State = Object.freeze({
	IDLE: 'idle',
	QUEUED: 'queued',
	GENERATING: 'generating',
	FAILED: 'failed',
});


/**
 * Generates every job's toolpath, and regenerates when the document changes.
 *
 * @param {Object} options - options
 * @param {Object} options.store - a project store
 * @param {Function} [options.generate] - the generator, injectable for tests
 * @param {Number} [options.settleMs=SETTLE_MS] - debounce
 * @param {Function} [options.schedule] - timer, injectable so tests need not wait
 * @returns {Object} `{ toolpaths, state, warnings, regenerate }`
 */
export function useToolpaths(options) {

	const {
		store,
		generate = generateAll,
		settleMs = SETTLE_MS,
		schedule = (fn, ms) => globalThis.setTimeout(fn, ms),
		cancel = (handle) => globalThis.clearTimeout(handle),
	} = options ?? {};

	if (store === undefined)
		throw new TypeError('useToolpaths needs a store');

	/** @type {import('vue').ShallowRef<Object[]>} one entry per job */
	const toolpaths = shallowRef([]);

	/** What the generator is doing. */
	const state = shallowRef(State.IDLE);

	/** Everything the jobs had to say, flattened. */
	const warnings = shallowRef([]);

	/** @type {*} the pending debounce */
	let pending = null;

	/**
	 * Generates now, whatever the debounce was going to do.
	 *
	 * @returns {Promise<Object[]>} the toolpaths
	 */
	async function regenerate() {

		if (pending !== null) {
			cancel(pending);
			pending = null;
		}

		state.value = State.GENERATING;

		try {

			const result = await generate(store.project);

			toolpaths.value = result;
			warnings.value = result.flatMap((entry) => entry.warnings);
			state.value = State.IDLE;

			return result;
		}
		catch (error) {

			// one thrown generator must not leave the view showing a toolpath for
			// a document that no longer exists, so the old result is dropped
			toolpaths.value = [];
			warnings.value = [error.message];
			state.value = State.FAILED;

			return [];
		}
	}

	/** Asks for a regeneration once things settle. */
	function queue() {

		if (pending !== null)
			cancel(pending);

		state.value = State.QUEUED;
		pending = schedule(() => { pending = null; regenerate(); }, settleMs);
	}

	watch(() => store.revision.value, queue, { immediate: true });

	onScopeDispose(() => {
		if (pending !== null)
			cancel(pending);
	});

	return { toolpaths, state, warnings, regenerate };
}
