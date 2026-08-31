/**
 * @file useProgram.js
 * @description Keeping the G-code in step with the document, and being honest
 * about when it is not.
 *
 * ---------------------------------------------------------------------------
 * Staleness is the whole point of this file
 *
 * Generating the program is cheap and could simply be a computed. What cannot be
 * a computed is the promise Export has to make: **the file you save is the
 * project you are looking at**. Between a keystroke and the regeneration that
 * follows it there is a window — small, but real, and made real again every time
 * the pipeline moves further off the main thread — where the text in the editor
 * describes a document that no longer exists.
 *
 * So the state is explicit and Export is gated on it. `stale` is not a nicety
 * for the status bar; it is the flag that stops someone exporting the previous
 * version of their part.
 *
 * The four states, and what each one means to the user:
 *
 *   idle        the text matches the document. Export is safe
 *   queued      the document moved; regeneration is waiting for it to settle
 *   generating  regeneration is running
 *   failed      it threw. There is no text, and the reason is in `warnings`
 *
 * `stale` is true in every state but `idle`, which is deliberately a separate
 * question from `state`: the status bar wants to say which of the four, and
 * Export only ever wants to know the one.
 * ---------------------------------------------------------------------------
 *
 * Regeneration follows the toolpaths rather than the document. The toolpaths are
 * the expensive half and they already debounce on command commits; running a
 * second debounce off the same signal would only mean emitting from a set of
 * toolpaths that is itself one edit behind.
 */

import { shallowRef, computed, watch } from 'vue';

import { generateProgram } from '@core/project/program.js';
import { State } from './useToolpaths.js';

export { State };


/**
 * Generates the program, and regenerates it when the toolpaths change.
 *
 * @param {Object} options - options
 * @param {Object} options.store - a project store
 * @param {import('vue').ShallowRef} options.toolpaths - from `useToolpaths`
 * @param {import('vue').ShallowRef} [options.state] - the toolpath generator's
 *   state, so this one can report `queued` while that one is still settling
 * @param {Function} [options.generate] - the generator, injectable for tests
 * @returns {Object} `{ text, lines, blocks, warnings, blocked, stats, travel,
 *   state, stale, canExport, regenerate }`
 */
export function useProgram(options) {

	const { store, toolpaths, state: upstream, generate = generateProgram } = options ?? {};

	if (store === undefined || toolpaths === undefined)
		throw new TypeError('useProgram needs a store and the toolpaths');

	/** The program itself. */
	const text = shallowRef('');

	/** @type {import('vue').ShallowRef<String[]>} the same program, per line */
	const lines = shallowRef([]);

	/** @type {import('vue').ShallowRef<Object[]>} `{ jobId, name, from, to }` */
	const blocks = shallowRef([]);

	/** @type {import('vue').ShallowRef<String[]>} */
	const warnings = shallowRef([]);

	/** @type {import('vue').ShallowRef<Object[]>} the diagnostics that stopped it */
	const blocked = shallowRef([]);

	/** Move counts, for the status bar. */
	const stats = shallowRef(null);

	/**
	 * The rapids between cuts, in workspace millimetres.
	 *
	 * Carried here rather than recomputed in the view, because the whole value of
	 * the travel layer is that it is what the machine will actually do — a
	 * second derivation of the ordering rule is a second one that can drift.
	 *
	 * @type {import('vue').ShallowRef<Object[]>}
	 */
	const travel = shallowRef([]);

	/** What this generator is doing, ignoring the one upstream. */
	const own = shallowRef(State.IDLE);

	/**
	 * What the pair of them are doing.
	 *
	 * The upstream generator settling counts as this one being out of date, and
	 * saying `queued` is more honest than saying `idle` while holding text that
	 * is about to be replaced.
	 */
	const state = computed(() => {

		const above = upstream?.value ?? State.IDLE;

		if (own.value === State.FAILED || above === State.FAILED)
			return State.FAILED;

		return above === State.IDLE ? own.value : above;
	});

	/** Whether the text describes a document that no longer exists. */
	const stale = computed(() => state.value !== State.IDLE);

	/** Whether Export may go ahead. */
	const canExport = computed(() =>
		!stale.value && blocked.value.length === 0 && text.value !== '');

	/**
	 * Generates now.
	 *
	 * @returns {Promise<String>} the program text
	 */
	async function regenerate() {

		own.value = State.GENERATING;

		try {

			const result = await generate(store.project, { toolpaths: toolpaths.value });

			text.value = result.text;
			lines.value = result.lines;
			blocks.value = result.blocks;
			warnings.value = result.warnings;
			blocked.value = result.blocked;
			stats.value = result.stats;
			travel.value = result.travel ?? [];
			own.value = State.IDLE;

			return result.text;
		}
		catch (error) {

			// The old text is dropped rather than left on screen. It is a
			// description of a document that is no longer there, and the one thing
			// worse than no G-code is G-code for the wrong part.
			text.value = '';
			lines.value = [];
			blocks.value = [];
			warnings.value = [error.message];
			blocked.value = [];
			stats.value = null;
			travel.value = [];
			own.value = State.FAILED;

			return '';
		}
	}

	watch(toolpaths, regenerate, { immediate: true });

	return {
		text, lines, blocks, warnings, blocked, stats, travel,
		state, stale, canExport, regenerate,
	};
}
