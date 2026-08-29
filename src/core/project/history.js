/**
 * @file history.js
 * @description Undo, redo, and the only write path into a project.
 *
 * Nothing here knows what a project node is. It moves opaque snapshots around
 * and calls out to a driver — `nodeDriver` in snapshot.js — for the four things
 * that do need to know: copy some of it, put it back, copy all of it, compare
 * two of them. See that file's header for why undo is snapshots and not inverse
 * commands, and for the rule about `touches`.
 *
 * ---------------------------------------------------------------------------
 * Two things this deliberately does NOT do
 *
 * It does not re-run `apply` for redo. Redo restores the after-snapshot, the
 * same way undo restores the before-snapshot. Re-running would be cheaper, and
 * it would also mean every command has to be a pure function of the state — no
 * fresh uuids, no timestamps, nothing read from outside — because a redo that
 * mints a different uuid than the original leaves every reference to the old one
 * pointing at nothing. Making redo a restore removes that whole class of bug and
 * the rule nobody would remember.
 *
 * It does not put selection changes on the stack. Clicking around does not fill
 * your undo history — but every real command captures the selection before and
 * after, so undoing a delete gives you back both the node AND the selection you
 * had. That is the behaviour people actually expect from "undo restores
 * selection", and it is why selection lives in the store rather than in a
 * component.
 * ---------------------------------------------------------------------------
 */

/**
 * @typedef {Object} Command
 * @property {String} label - what the undo menu says, e.g. "Move job"
 * @property {String[]} touches - ids of the subtrees `apply` will change. See
 *   the rule in snapshot.js: the node whose CONTENTS change, which for a
 *   structural edit is the parent
 * @property {Function} apply - mutates the state; the only place that may
 * @property {String} [coalesceKey] - drags and typing collapse into one entry
 *   while this stays the same and the entry is unsealed
 */

/**
 * @typedef {Object} Entry
 * @property {String} label - the command's label
 * @property {String[]} touches - what it changed
 * @property {Object} before - snapshot taken before `apply`
 * @property {Object} after - snapshot taken after it
 * @property {String|null} coalesceKey - null when the command was not coalescable
 * @property {Boolean} sealed - true once nothing more may merge into it
 * @property {Number} at - when it was last written to
 */

/** How long an unsealed entry stays open to coalescing. See `createHistory`. */
export const DEFAULT_COALESCE_WINDOW_MS = 1000;

/** How many entries to keep. Roughly a session's worth of real work. */
export const DEFAULT_LIMIT = 200;


/**
 * Creates an undo/redo history.
 *
 * The history holds the stacks and nothing else — the state is passed in on
 * every call, so one history cannot silently be pointed at the wrong document,
 * and the store in 3.2 stays the only thing that owns state.
 *
 * @param {Object} options - options
 * @param {Object} options.driver - `capture`, `restore`, and for `verify` also
 *   `cloneState` and `diffStates`. See `nodeDriver` in snapshot.js
 * @param {Number} [options.limit=DEFAULT_LIMIT] - entries kept before the oldest is dropped
 * @param {Number} [options.coalesceWindowMs=DEFAULT_COALESCE_WINDOW_MS] - see below
 * @param {Boolean} [options.verify=false] - check every command's `touches` against
 *   what it actually changed. Correctness insurance, at the price of copying the
 *   whole document twice per command: on in tests, off in production
 * @param {Function} [options.now=Date.now] - the clock, so tests need not sleep
 * @param {Function} [options.onCommit] - called after every change with
 *   `{ kind, label, touches }`. This is the G-code regeneration trigger: it fires
 *   once per committed command rather than once per mouse move, so debouncing
 *   codegen is not a separate mechanism
 * @returns {Object} the history
 */
export function createHistory(options) {

	const {
		driver,
		limit = DEFAULT_LIMIT,
		coalesceWindowMs = DEFAULT_COALESCE_WINDOW_MS,
		verify = false,
		now = Date.now,
		onCommit = null,
	} = options ?? {};

	if (driver === undefined || typeof driver.capture !== 'function' || typeof driver.restore !== 'function')
		throw new TypeError('createHistory needs a driver with capture and restore');

	if (verify && (typeof driver.cloneState !== 'function' || typeof driver.diffStates !== 'function'))
		throw new TypeError('verify needs a driver with cloneState and diffStates');

	if (!(limit >= 1))
		throw new RangeError(`limit must be at least 1, got ${limit}`);

	/** @type {Entry[]} oldest first, so the newest is the last */
	const past = [];

	/** @type {Entry[]} newest first, so the next redo is the last */
	const future = [];

	/**
	 * Announces a change, if anyone is listening.
	 *
	 * @param {String} kind - `do`, `coalesce`, `undo` or `redo`
	 * @param {Entry} entry - the entry involved
	 */
	function announce(kind, entry) {
		onCommit?.({ kind, label: entry.label, touches: entry.touches });
	}

	/**
	 * Checks that a command actually only changed what it said it would.
	 *
	 * Runs the round trip for real: copy the whole document, put the
	 * before-snapshot back, and see whether the document is exactly as it was. If
	 * it is not, `touches` is missing something, and the difference is reported
	 * where it happened rather than as a wrong document ten operations later.
	 *
	 * @param {Object} state - the project state, after `apply`
	 * @param {Object} whole - a copy of the state from before `apply`
	 * @param {Object} probe - a snapshot of `touches` from before `apply`
	 * @param {Object} after - a snapshot of `touches` from after it
	 * @param {Command} command - the command, for the message
	 * @throws {Error} when undoing the command would not restore the document
	 */
	function check(state, whole, probe, after, command) {

		driver.restore(state, probe);

		const differences = driver.diffStates(whole, state);

		driver.restore(state, after);

		if (differences.length === 0)
			return;

		throw new Error(
			`"${command.label}" changed something outside its touches [${command.touches.join(', ')}],`
			+ ` so undoing it would not put the document back:\n  ${differences.join('\n  ')}`);
	}

	/**
	 * Whether an incoming command may merge into the entry on top.
	 *
	 * The touches must match as well as the key. A drag that starts changing a
	 * different node halfway through is a different edit, and merging it into an
	 * entry whose before-snapshot never covered that node would leave undo unable
	 * to reach the earlier value.
	 *
	 * @param {Entry} entry - the top of the past stack
	 * @param {Command} command - the incoming command
	 * @returns {Boolean} true when it may merge
	 */
	function mergeable(entry, command) {

		if (entry === undefined || entry.sealed || command.coalesceKey == null)
			return false;

		if (entry.coalesceKey !== command.coalesceKey)
			return false;

		if (now() - entry.at > coalesceWindowMs)
			return false;

		return entry.touches.length === command.touches.length
			&& entry.touches.every((id, i) => id === command.touches[i]);
	}

	/**
	 * Runs a command and records it.
	 *
	 * The only way anything may change the project. Components never mutate the
	 * store; they dispatch.
	 *
	 * @param {Object} state - the project state, mutated in place
	 * @param {Command} command - what to do
	 * @returns {Entry} the entry it went into, new or merged
	 * @throws {TypeError} when the command is malformed
	 * @throws {Error} in verify mode, when the command changes more than it declared
	 */
	function dispatch(state, command) {

		validate(command);

		// a new edit makes any redo unreachable, and holding on to it would let
		// a later redo restore a snapshot of a document that no longer exists
		future.length = 0;

		const top = past.at(-1);
		const merging = mergeable(top, command);

		const whole = verify ? driver.cloneState(state) : null;
		const probe = driver.capture(state, command.touches);

		command.apply(state);

		const after = driver.capture(state, command.touches);

		if (verify)
			check(state, whole, probe, after, command);

		if (merging) {

			// keep the entry's original `before`: undo should reach the value from
			// before the drag started, not from before its last few pixels
			top.after = after;
			top.at = now();
			top.label = command.label;

			announce('coalesce', top);

			return top;
		}

		/** @type {Entry} */
		const entry = {
			label: command.label,
			touches: [...command.touches],
			before: probe,
			after,
			coalesceKey: command.coalesceKey ?? null,
			sealed: false,
			at: now(),
		};

		past.push(entry);

		while (past.length > limit)
			past.shift();

		announce('do', entry);

		return entry;
	}

	/**
	 * Closes the entry on top to further coalescing.
	 *
	 * Call it on mouse-up, on blur, whenever an interaction ends. The time window
	 * is only a safety net for the places that forget; this is the mechanism.
	 */
	function seal() {

		const top = past.at(-1);

		if (top !== undefined)
			top.sealed = true;
	}

	/**
	 * Undoes the most recent command.
	 *
	 * @param {Object} state - the project state, mutated in place
	 * @returns {Entry|null} what was undone, or null when there was nothing
	 */
	function undo(state) {

		const entry = past.pop();

		if (entry === undefined)
			return null;

		driver.restore(state, entry.before);
		future.push(entry);

		// whatever is on top now belongs to an older interaction
		seal();

		announce('undo', entry);

		return entry;
	}

	/**
	 * Redoes the most recently undone command.
	 *
	 * @param {Object} state - the project state, mutated in place
	 * @returns {Entry|null} what was redone, or null when there was nothing
	 */
	function redo(state) {

		const entry = future.pop();

		if (entry === undefined)
			return null;

		driver.restore(state, entry.after);
		past.push(entry);
		seal();

		announce('redo', entry);

		return entry;
	}

	/**
	 * Forgets everything. For loading a project into an existing store.
	 *
	 * The snapshots describe a document that is no longer open, so keeping them
	 * would let one undo splice the previous project's nodes into this one.
	 */
	function clear() {
		past.length = 0;
		future.length = 0;
	}

	return {
		dispatch,
		undo,
		redo,
		seal,
		clear,

		/** @returns {Boolean} whether there is anything to undo */
		canUndo: () => past.length > 0,

		/** @returns {Boolean} whether there is anything to redo */
		canRedo: () => future.length > 0,

		/** @returns {String|null} the label for the undo menu item */
		undoLabel: () => past.at(-1)?.label ?? null,

		/** @returns {String|null} the label for the redo menu item */
		redoLabel: () => future.at(-1)?.label ?? null,

		/** @returns {Object} how deep each stack is, for tests and the status bar */
		depth: () => ({ past: past.length, future: future.length }),
	};
}


/**
 * Rejects a malformed command before it can half-run.
 *
 * @param {Command} command - the command
 * @throws {TypeError} naming what is wrong with it
 */
function validate(command) {

	if (command === null || typeof command !== 'object')
		throw new TypeError('a command must be an object');

	if (typeof command.label !== 'string' || command.label.trim() === '')
		throw new TypeError('a command needs a label, for the undo menu');

	if (typeof command.apply !== 'function')
		throw new TypeError(`"${command.label}" has no apply`);

	if (!Array.isArray(command.touches) || command.touches.length === 0)
		throw new TypeError(
			`"${command.label}" declares no touches. Name the nodes whose contents change —`
			+ ' for a structural edit that is the parent, not the child.');

	for (const id of command.touches)
		if (typeof id !== 'string' || id === '')
			throw new TypeError(`"${command.label}" has a touches entry that is not an id: ${String(id)}`);

	if (new Set(command.touches).size !== command.touches.length)
		throw new TypeError(`"${command.label}" lists the same id twice in touches`);
}
