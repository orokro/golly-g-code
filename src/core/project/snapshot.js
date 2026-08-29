/**
 * @file snapshot.js
 * @description Copying, restoring and comparing pieces of the project tree.
 *
 * This is the half of the command system that knows what the state looks like.
 * `history.js` is the half that knows nothing about it, and the two meet through
 * the driver object at the bottom of this file.
 *
 * ---------------------------------------------------------------------------
 * Why snapshots and not inverse commands
 *
 * The obvious design for undo is a pair per command: `apply` and `revert`. It
 * uses the least memory of anything, and it is the one we are NOT using, because
 * the two halves are written by hand and only one of them is exercised while you
 * work. A `revert` that is subtly incomplete does not fail — it leaves the
 * document slightly wrong, and you find out several operations later, by which
 * time the stack has moved on and there is nothing to inspect.
 *
 * So a command declares which node subtrees it will change and supplies `apply`
 * only. The dispatcher copies those subtrees before running it and again after;
 * undo and redo are both a restore. Nobody writes an inverse, so nobody writes a
 * wrong one.
 *
 * The declaration earns its keep twice: it is also exactly the set of nodes
 * whose G-code is now stale (5.2), so per-job cache invalidation comes free
 * rather than being a second thing to keep in step.
 *
 * The one way this design CAN be wrong is a command that changes something it
 * did not declare. That is what `cloneState` and `diffStates` are for — see
 * `verify` in history.js, which turns an under-declared command into an
 * immediate, loud failure at the point of the mistake.
 * ---------------------------------------------------------------------------
 *
 * THE RULE FOR `touches`: name the node whose CONTENTS change. Editing a field
 * touches that node. Adding, deleting, or reordering a child changes the
 * parent's `children` array, so it touches the PARENT. Moving a node between
 * parents touches both. Getting this wrong is the failure mode above, and
 * `verify` exists because getting it wrong is easy.
 */

/**
 * @typedef {Object} ProjectNode
 * @property {String} id - stable uuid
 * @property {String} type - node kind, see 3.2
 * @property {String[]} [children] - ids of child nodes, in meaningful order
 */

/**
 * @typedef {Object} ProjectState
 * @property {Object<String, ProjectNode>} nodes - every node, by id
 * @property {String} root - the id of the Project node
 * @property {Object} [selection] - what is selected, restored along with the data
 */

/**
 * @typedef {Object} Snapshot
 * @property {Array<{id: String, nodes: Object}>} subtrees - a copy of each touched subtree
 * @property {Object|null} selection - the selection as it was
 */


/**
 * Deep-copies plain project data.
 *
 * Not `structuredClone`, for two reasons, and the second is the important one.
 *
 * It refuses anything that is not plain data rather than quietly producing a
 * shallow or empty copy of it: a Date or a Map that came back from undo as `{}`
 * would be a corrupted document with no error attached to it. Rule 5.
 *
 * And `structuredClone` throws `DataCloneError` on a Proxy, where a hand-written
 * walk reads straight through the traps. The renderer's convention is shallow
 * reactivity only (see `renderer/CONVENTIONS.md`), so project state is a plain
 * object and no proxy should ever reach this — but "should never" is a rule
 * someone eventually breaks, and the cost of being immune to it is nothing.
 *
 * @param {*} value - plain data: primitives, arrays, plain objects
 * @param {String} [path] - where we are, for the error message
 * @returns {*} a copy sharing nothing with the original
 * @throws {TypeError} when the value is not plain data
 */
export function cloneData(value, path = '') {

	if (value === null || typeof value !== 'object')
		return handlePrimitive(value, path);

	if (Array.isArray(value))
		return value.map((item, index) => cloneData(item, `${path}[${index}]`));

	const prototype = Object.getPrototypeOf(value);

	if (prototype !== Object.prototype && prototype !== null)
		throw new TypeError(`project state may only hold plain data, found ${describe(value)} at ${path || 'the root'}`);

	/** @type {Object} */
	const copy = {};

	for (const [key, item] of Object.entries(value))
		copy[key] = cloneData(item, path === '' ? key : `${path}.${key}`);

	return copy;
}

/**
 * Checks a non-object value on its way through `cloneData`.
 *
 * @param {*} value - the value
 * @param {String} path - where it is
 * @returns {*} the value itself
 * @throws {TypeError} when it is a function or a symbol
 */
function handlePrimitive(value, path) {

	const type = typeof value;

	if (type === 'function' || type === 'symbol')
		throw new TypeError(`project state may only hold plain data, found a ${type} at ${path || 'the root'}`);

	return value;
}

/**
 * Names a value for an error message.
 *
 * @param {Object} value - the value
 * @returns {String} something a human can act on
 */
function describe(value) {

	if (value instanceof Date)
		return 'a Date';

	if (value instanceof Map || value instanceof Set)
		return `a ${value.constructor.name}`;

	return `an instance of ${value.constructor?.name ?? 'an anonymous class'}`;
}


/**
 * Every node id reachable from a starting node, including it.
 *
 * Tolerates an id that is not in the state — a subtree can be captured after the
 * node it names has been deleted, which is how redo of a delete works.
 *
 * @param {ProjectState} state - the project state
 * @param {String} id - the node to start from
 * @param {Set<String>} [into] - collected here, so several roots can share a set
 * @returns {Set<String>} the ids
 */
export function reachable(state, id, into = new Set()) {

	if (into.has(id))
		return into;

	const node = state.nodes[id];

	if (node === undefined)
		return into;

	into.add(id);

	// the `into` check above also guards against a malformed cycle, which would
	// otherwise be a stack overflow with no indication of which node caused it
	for (const child of node.children ?? [])
		reachable(state, child, into);

	return into;
}


/**
 * Copies the subtrees a command is about to change, plus the selection.
 *
 * @param {ProjectState} state - the project state
 * @param {String[]} ids - the roots of the subtrees to copy
 * @returns {Snapshot} a copy sharing nothing with the state
 */
export function capture(state, ids) {

	const subtrees = ids.map((id) => {

		/** @type {Object<String, ProjectNode>} */
		const nodes = {};

		for (const found of reachable(state, id))
			nodes[found] = cloneData(state.nodes[found], found);

		return { id, nodes };
	});

	return {
		subtrees,
		selection: state.selection === undefined ? null : cloneData(state.selection, 'selection'),
	};
}


/**
 * Puts a captured snapshot back.
 *
 * In two passes, and it has to be. A command that moves a node from one parent
 * to another touches both, so both are captured; restoring them one at a time
 * would re-add the node under its old parent and then delete it again while
 * clearing out the new one, because it is still listed in the new parent's
 * children until that subtree is put back.
 *
 * @param {ProjectState} state - the project state, mutated in place
 * @param {Snapshot} snapshot - what `capture` returned
 */
export function restore(state, snapshot) {

	/** Everything currently hanging off a captured root. @type {Set<String>} */
	const present = new Set();

	for (const { id } of snapshot.subtrees)
		reachable(state, id, present);

	for (const id of present)
		delete state.nodes[id];

	for (const { nodes } of snapshot.subtrees)
		for (const [id, node] of Object.entries(nodes))
			state.nodes[id] = cloneData(node, id);

	if (snapshot.selection !== null)
		state.selection = cloneData(snapshot.selection, 'selection');
}


/**
 * A copy of the whole state.
 *
 * Only used by `verify`, which is why it is allowed to be the expensive thing it
 * obviously is.
 *
 * @param {ProjectState} state - the project state
 * @returns {ProjectState} a copy sharing nothing with it
 */
export function cloneState(state) {
	return cloneData(state, '');
}


/**
 * Where two states differ, as paths.
 *
 * A diagnostic, not a predicate: an empty result means equal, and a non-empty
 * one is meant to be read by whoever wrote the command that caused it. Stops
 * early, because a command that misses one node usually misses several and the
 * first few say everything.
 *
 * @param {*} expected - the state as it should be
 * @param {*} actual - the state as it is
 * @param {Object} [options] - options
 * @param {Number} [options.limit=12] - stop after this many differences
 * @returns {String[]} human-readable descriptions, empty when the two agree
 */
export function diffStates(expected, actual, options = {}) {

	const { limit = 12 } = options;

	/** @type {String[]} */
	const found = [];

	compare(expected, actual, '', found, limit);

	return found;
}

/**
 * The recursive half of `diffStates`.
 *
 * @param {*} expected - the value as it should be
 * @param {*} actual - the value as it is
 * @param {String} path - where we are
 * @param {String[]} found - differences collected here
 * @param {Number} limit - stop once this many are found
 */
function compare(expected, actual, path, found, limit) {

	if (found.length >= limit)
		return;

	const where = path === '' ? 'the root' : path;

	if (expected === actual)
		return;

	if (expected === null || actual === null
		|| typeof expected !== 'object' || typeof actual !== 'object') {

		found.push(`${where}: expected ${show(expected)}, found ${show(actual)}`);
		return;
	}

	if (Array.isArray(expected) !== Array.isArray(actual)) {
		found.push(`${where}: expected ${Array.isArray(expected) ? 'an array' : 'an object'}, found the other`);
		return;
	}

	if (Array.isArray(expected)) {

		if (expected.length !== actual.length)
			found.push(`${where}: expected ${expected.length} entries, found ${actual.length}`);

		for (let i = 0; i < Math.max(expected.length, actual.length); i += 1)
			compare(expected[i], actual[i], `${path}[${i}]`, found, limit);

		return;
	}

	for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)]))
		compare(expected[key], actual[key], path === '' ? key : `${path}.${key}`, found, limit);
}

/**
 * Renders a value for a difference message.
 *
 * @param {*} value - the value
 * @returns {String} short and readable
 */
function show(value) {

	if (typeof value === 'string')
		return JSON.stringify(value);

	if (value === undefined)
		return 'nothing';

	return String(value);
}


/**
 * What `createHistory` needs in order to know nothing about project state.
 *
 * Kept as one object so a test — or a second document type — can supply its own
 * without history.js growing a special case.
 *
 * @type {Object}
 */
export const nodeDriver = Object.freeze({ capture, restore, cloneState, diffStates });
