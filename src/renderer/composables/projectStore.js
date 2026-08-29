/**
 * @file projectStore.js
 * @description The reactive skin over a project, and the only write path into it.
 *
 * A FACTORY, not a singleton. Every store is keyed by its project's id, which
 * costs nothing today and is the whole structural prerequisite for multi-project
 * tabs later — a singleton would have to be unpicked out of every component that
 * ever imported it.
 *
 * ---------------------------------------------------------------------------
 * How this is reactive without a single deep proxy
 *
 * The document is a PLAIN object. Nothing wraps it, so `src/core` can walk it,
 * clone it and diff it at full speed, and so the undo snapshots are plain data.
 * Reactivity is per node and explicit: `nodeRef(id)` hands out a `shallowRef`,
 * and after every commit the store REPLACES the refs for the nodes that actually
 * changed. A view watching one job does not re-run because another job moved.
 *
 * Which nodes to republish is not guesswork. A history entry carries the before
 * and after snapshots of exactly the subtrees the command touched, so the union
 * of the ids in them is precisely the set whose data can differ — additions,
 * deletions and edits alike. `touches` was written for undo, it invalidates
 * G-code in 5.2, and it drives this. One list, three jobs.
 *
 * A correction worth writing down, because the obvious explanation of this is
 * wrong. Republishing EVERY ref on every commit does not actually make views
 * re-run: `shallowRef` compares with `Object.is`, and an untouched node is still
 * the same object, so the assignment is a no-op. Mutating the store to do that
 * broke no test, which is how the mistake was found.
 *
 * So the touched set is not what makes this fine-grained — object identity is.
 * What the touched set buys is CORRECTNESS, and only for the nodes whose
 * identity really did change: undo and redo restore CLONES, so every node inside
 * a restored subtree is a new object and must be republished, and a deleted node
 * has to go to null. Publish too little and a view holds a detached object
 * forever, with no error. That is the same failure shape as an under-declared
 * `touches`, and `verify` is what catches the underlying cause.
 * ---------------------------------------------------------------------------
 *
 * Structure — "what are this folder's children" — is not per-node reactive, and
 * making it so would mean a ref per relationship. Views that draw the tree watch
 * `revision`, which bumps once per commit.
 */

import { shallowRef, computed } from 'vue';

import { createHistory } from '@core/project/history.js';
import { nodeDriver } from '@core/project/snapshot.js';
import { diagnose } from '@core/project/diagnostics.js';
import { resolveNode, resolvedValues } from '@core/project/inherit.js';
import { parentIndex, childrenOf, validateTree } from '@core/project/tree.js';

/**
 * Whether to check every command against what it actually changed.
 *
 * On in development and in tests, because it is the thing that turns a wrong
 * `touches` from a silent stale view into an immediate failure. Off in a build,
 * because it copies the whole document twice per command.
 */
const VERIFY_BY_DEFAULT = import.meta.env?.DEV === true;


/**
 * Creates a store for one project.
 *
 * @param {Object} options - options
 * @param {Object} options.project - `{ version, document, geometry }` from `createProject`
 * @param {Boolean} [options.verify] - see {@link VERIFY_BY_DEFAULT}
 * @param {Function} [options.onCommit] - called after every committed change with
 *   `{ kind, label, touches }`. The G-code regeneration trigger
 * @param {Object} [options.historyOptions] - passed through to `createHistory`
 * @returns {Object} the store
 * @throws {TypeError} when the project is not one
 */
export function createProjectStore(options) {

	const { project, verify = VERIFY_BY_DEFAULT, onCommit, historyOptions = {} } = options ?? {};

	if (project?.document?.nodes === undefined)
		throw new TypeError('createProjectStore needs a project from createProject');

	/** The plain, unwrapped document. Nothing proxies this. */
	const document = project.document;

	const history = createHistory({ driver: nodeDriver, verify, onCommit, ...historyOptions });

	/** @type {Map<String, import('vue').ShallowRef>} handed out lazily, kept forever */
	const refs = new Map();

	/** Bumped once per commit. What tree-shaped views watch. */
	const revision = shallowRef(0);

	/** The selection, mirrored out of the document. */
	const selection = shallowRef(document.selection);

	/** Whether there are changes since the last save. Cleared by `markSaved`. */
	const dirty = shallowRef(false);

	/**
	 * A ref holding one node.
	 *
	 * Returns the same ref for the same id every time, so two components watching
	 * a node watch the same thing. The value is `null` while the node does not
	 * exist — which is a real state, not an error: a view can hold the ref of a
	 * node an undo has temporarily removed, and a redo brings it back.
	 *
	 * @param {String} id - the node
	 * @returns {import('vue').ShallowRef} the node, or null
	 */
	function nodeRef(id) {

		let ref = refs.get(id);

		if (ref === undefined) {
			ref = shallowRef(document.nodes[id] ?? null);
			refs.set(id, ref);
		}

		return ref;
	}

	/**
	 * Every node id an entry could have changed.
	 *
	 * The union of both snapshots rather than either one: a node only in `before`
	 * was deleted, a node only in `after` was added, and one in both may have been
	 * edited. All three need their ref replaced.
	 *
	 * @param {Object} entry - a history entry
	 * @returns {Set<String>} the ids
	 */
	function touchedBy(entry) {

		/** @type {Set<String>} */
		const ids = new Set();

		for (const snapshot of [entry.before, entry.after])
			for (const { nodes } of snapshot.subtrees)
				for (const id of Object.keys(nodes))
					ids.add(id);

		return ids;
	}

	/**
	 * Publishes a change to the views.
	 *
	 * @param {Object} entry - the history entry that just applied
	 */
	function publish(entry) {

		for (const id of touchedBy(entry)) {

			const ref = refs.get(id);

			if (ref !== undefined)
				ref.value = document.nodes[id] ?? null;
		}

		selection.value = document.selection;
		revision.value += 1;
		dirty.value = true;
	}

	/**
	 * Runs a command. The only way anything may change the document.
	 *
	 * @param {Object} command - from `core/project/commands.js`
	 * @returns {Object} the history entry
	 */
	function dispatch(command) {

		const entry = history.dispatch(document, command);

		publish(entry);

		return entry;
	}

	/**
	 * Undoes the last command.
	 *
	 * @returns {Object|null} the entry, or null when there was nothing to undo
	 */
	function undo() {

		const entry = history.undo(document);

		if (entry !== null)
			publish(entry);

		return entry;
	}

	/**
	 * Redoes the last undone command.
	 *
	 * @returns {Object|null} the entry, or null when there was nothing to redo
	 */
	function redo() {

		const entry = history.redo(document);

		if (entry !== null)
			publish(entry);

		return entry;
	}

	/**
	 * Changes what is selected.
	 *
	 * NOT a command, deliberately: clicking around must not fill the undo stack.
	 * It still lands in the document, so the next command captures it and undoing
	 * that command gives back the selection you had when you made it.
	 *
	 * @param {String[]} ids - what should be selected
	 * @param {Object} [options] - options
	 * @param {String} [options.active] - the one the Inspector shows; the last of
	 *   `ids` by default
	 */
	function select(ids, options = {}) {

		const present = ids.filter((id) => document.nodes[id] !== undefined);
		const active = options.active ?? present.at(-1) ?? null;

		document.selection = { active, ids: present };
		selection.value = document.selection;
	}

	/**
	 * Replaces the whole document, as loading a project does.
	 *
	 * Clears the history, because its snapshots describe a document that is no
	 * longer open and one undo would splice the previous project's nodes into
	 * this one. Every ref is repointed, including to null for nodes the new
	 * project does not have.
	 *
	 * @param {Object} loaded - a project from `createProject` or from a file
	 * @throws {TypeError} when it is not a project
	 */
	function load(loaded) {

		if (loaded?.document?.nodes === undefined)
			throw new TypeError('load needs a project from createProject');

		history.clear();

		// refilled in place rather than reassigned, so that every closure here
		// and every caller holding `store.document` keeps working. The document
		// object's identity is part of the store's contract
		for (const key of Object.keys(document))
			delete document[key];

		Object.assign(document, loaded.document);

		project.version = loaded.version;
		project.geometry = loaded.geometry ?? {};
		project.document = document;

		for (const [id, ref] of refs)
			ref.value = document.nodes[id] ?? null;

		selection.value = document.selection;
		revision.value += 1;
		dirty.value = false;
	}

	/** Records that what is in memory now matches what is on disk. */
	function markSaved() {
		dirty.value = false;
	}

	/**
	 * A computed that recomputes once per commit.
	 *
	 * Reading `revision.value` as the argument is what establishes the dependency
	 * — the value itself is never wanted, only the fact that it was read.
	 *
	 * @param {Function} compute - what to work out
	 * @returns {import('vue').ComputedRef} the result, refreshed per commit
	 */
	const perCommit = (compute) => computed(() => compute(revision.value));

	return {

		/** The project id. A store is keyed by this. */
		id: document.root,

		/** The plain project. Read freely; write only through `dispatch`. */
		project,

		/** The plain document, for the core's tree and inheritance functions. */
		document,

		nodeRef,
		dispatch,
		undo,
		redo,
		select,
		load,
		markSaved,

		/** Closes the current entry to coalescing. Call on mouse-up and on blur. */
		seal: history.seal,

		revision,
		selection,
		dirty,

		/** Everything the project has to say about itself, recomputed per commit. */
		diagnostics: perCommit(() => diagnose(project)),

		/** Structural problems. Empty unless a loaded file was hand-edited. */
		problems: perCommit(() => validateTree(document)),

		canUndo: perCommit(() => history.canUndo()),
		canRedo: perCommit(() => history.canRedo()),
		undoLabel: perCommit(() => history.undoLabel()),
		redoLabel: perCommit(() => history.redoLabel()),

		/**
		 * A node's children, as nodes. Read inside a computed that also reads
		 * `revision`, or it will not update when the tree changes.
		 *
		 * @param {String} id - the parent
		 * @returns {Object[]} the children in order
		 */
		children: (id) => childrenOf(document, id),

		/**
		 * A node's fields with their values and provenance, for the Inspector.
		 *
		 * @param {String} id - the node
		 * @returns {Object} by field name
		 */
		resolved: (id) => resolveNode(document, id, parentIndex(document)),

		/**
		 * A node's fields as plain values, for the CAM core.
		 *
		 * @param {String} id - the node
		 * @returns {Object} by field name
		 */
		values: (id) => resolvedValues(document, id, parentIndex(document)),
	};
}
