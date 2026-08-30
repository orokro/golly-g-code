/**
 * @file commands.js
 * @description The edits a project supports, as commands.
 *
 * Every one of these is a factory returning a `{ label, touches, apply }` for
 * `createHistory().dispatch`. Nothing else in the application may write to the
 * document — see rule 3 in renderer/CONVENTIONS.md — so this file is the whole
 * vocabulary of change, and it is short on purpose.
 *
 * ---------------------------------------------------------------------------
 * `touches` means "data I will change", not "things that now look different"
 *
 * Editing a Tool's cut feed touches the Tool and nothing else: no job's stored
 * data changes, because a job that inherits stores nothing to change. What DOES
 * change is what those jobs resolve to, and therefore their G-code. That
 * expansion — through inheritance with `dependentsOf`, and down the tree for
 * containment — belongs to whoever is asking about staleness (5.2), not here.
 * Widening `touches` to cover it would make undo copy, and restore, subtrees no
 * command actually wrote to.
 *
 * The one place this is genuinely subtle is deleting a node other nodes refer to
 * — a path a job cuts. Removing the dangling reference is a real write to the
 * job, so the job is in `touches`. `verify` catches it if it is forgotten, which
 * is how it was caught.
 * ---------------------------------------------------------------------------
 */

import { Kind, FIELDS, fieldsOf, fieldSpec } from './nodes.js';
import { validateValue } from './schema.js';
import { parentIndex, parentOf, descendantsOf } from './tree.js';

/**
 * Sets one field on one node.
 *
 * Coalescing is keyed to the node and field, so dragging a slider or typing into
 * a box collapses into a single undo entry — and the moment focus moves to
 * another field, the key changes and a new entry starts on its own.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node
 * @param {String} field - the field name
 * @param {*} value - the new value
 * @param {Object} [options] - options
 * @param {Boolean} [options.coalesce=true] - false for a single deliberate change
 * @returns {Object} a command
 * @throws {TypeError} for an unknown node or field
 * @throws {RangeError} when the value is not one the field accepts
 */
export function setField(document, id, field, value, options = {}) {

	const { coalesce = true } = options;
	const node = document.nodes[id];

	if (node === undefined)
		throw new TypeError(`No node "${id}" in the document`);

	const spec = fieldSpec(node.type, field);

	if (spec === null)
		throw new TypeError(`${node.type} has no field "${field}"`);

	// checked here rather than at commit, so a bad value never enters the undo
	// stack and cannot be reached by undoing back through it
	const issues = validateValue(node.type, field, value);

	if (issues.length > 0)
		throw new RangeError(`${spec.label}: ${issues.join('; ')}`);

	return {
		label: `Set ${spec.label.toLowerCase()}`,
		touches: [id],
		coalesceKey: coalesce ? `field:${id}:${field}` : undefined,
		apply: (state) => { state.nodes[id][field] = value; },
	};
}


/**
 * Removes a node's own value for a field, putting it back on the inherited one.
 *
 * This is the reset button, and it restores the LINK rather than the value. A
 * reset that wrote the tool's current feed into the job would look identical
 * today and behave completely differently the next time the tool is corrected.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node
 * @param {String} field - the field name
 * @returns {Object} a command
 * @throws {TypeError} for an unknown node, or a field that cannot be inherited
 */
export function clearOverride(document, id, field) {

	const node = document.nodes[id];

	if (node === undefined)
		throw new TypeError(`No node "${id}" in the document`);

	const spec = fieldSpec(node.type, field);

	if (spec?.inherit === undefined)
		throw new TypeError(`${node.type}.${field} is not an inheritable field, so there is no link to restore`);

	return {
		label: `Reset ${spec.label.toLowerCase()}`,
		touches: [id],
		apply: (state) => { delete state.nodes[id][field]; },
	};
}


/**
 * Adds an already-built node under a parent.
 *
 * The node is made by the caller rather than inside `apply`, which keeps `apply`
 * free of id minting. Redo restores rather than re-running, so this would be
 * safe either way — but a command whose result depends on when it ran is a
 * thing to avoid on principle, not only where it currently bites.
 *
 * @param {Object} document - the project document
 * @param {String} parentId - where it goes
 * @param {Object} node - the node, from `createNode`
 * @param {Object} [options] - options
 * @param {Number} [options.index] - position among the children; appended by default
 * @param {Boolean} [options.select=true] - select the new node, so undo restores
 *   the selection you had before it existed
 * @returns {Object} a command
 * @throws {TypeError} when the parent is unknown or may not hold this type
 */
export function addNode(document, parentId, node, options = {}) {

	const { index, select = true } = options;
	const parent = document.nodes[parentId];

	if (parent === undefined)
		throw new TypeError(`No node "${parentId}" in the document`);

	if ((FIELDS[node.type]) === undefined)
		throw new TypeError(`Unknown node type "${node.type}"`);

	return {
		label: `Add ${node.type.toLowerCase()}`,
		touches: [parentId],
		apply: (state) => {

			state.nodes[node.id] = node;

			const children = state.nodes[parentId].children;
			const at = index ?? children.length;

			children.splice(Math.max(0, Math.min(at, children.length)), 0, node.id);

			if (select)
				state.selection = { active: node.id, ids: [node.id] };
		},
	};
}


/**
 * Adds a whole subtree under a parent, in one command.
 *
 * An SVG import is a document node with a dozen paths under it, and the first
 * job in an empty project is a Tool with a Job inside it. Both are ONE thing the
 * user did, so both are one entry in the undo stack — a dozen entries to undo an
 * import that was one click is not a history, it is a chore.
 *
 * The nodes are built by the caller and must already reference each other; only
 * the first is attached to `parentId`.
 *
 * @param {Object} document - the project document
 * @param {String} parentId - where the first node goes
 * @param {Object[]} nodes - the subtree, its root first
 * @param {Object} [options] - options
 * @param {String} [options.label] - what the undo menu should say
 * @param {Boolean} [options.select=true] - select the root of what was added
 * @returns {Object} a command
 * @throws {TypeError} when the parent is unknown or the subtree is empty
 */
export function addSubtree(document, parentId, nodes, options = {}) {

	const { select = true } = options;
	const parent = document.nodes[parentId];

	if (parent === undefined)
		throw new TypeError(`No node "${parentId}" in the document`);

	if (Array.isArray(nodes) === false || nodes.length === 0)
		throw new TypeError('addSubtree needs at least one node');

	const [root] = nodes;
	const label = options.label ?? `Add ${root.type.toLowerCase()}`;

	return {
		label,
		touches: [parentId],
		apply: (state) => {

			for (const node of nodes)
				state.nodes[node.id] = node;

			state.nodes[parentId].children.push(root.id);

			if (select)
				state.selection = { active: root.id, ids: [root.id] };
		},
	};
}


/**
 * Removes a node and everything under it.
 *
 * Also strips the removed ids out of every reference list that mentions them,
 * which is why the referring nodes are in `touches` — a job left pointing at a
 * deleted path is a dangling reference that `validateTree` would find and no
 * amount of undoing would explain.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node to remove
 * @returns {Object} a command
 * @throws {TypeError} when the node is unknown or is the root
 */
export function removeNode(document, id) {

	const node = document.nodes[id];

	if (node === undefined)
		throw new TypeError(`No node "${id}" in the document`);

	if (id === document.root)
		throw new TypeError('The project node cannot be removed');

	const parent = parentOf(document, id);

	if (parent === null)
		throw new TypeError(`${id} has no parent, so it is not attached to the document`);

	const going = new Set(descendantsOf(document, id));
	const referrers = referrersTo(document, going).filter((other) => going.has(other) === false);

	return {
		label: `Delete ${node.type.toLowerCase()}`,
		touches: [parent.id, ...referrers],
		apply: (state) => {

			state.nodes[parent.id].children =
				state.nodes[parent.id].children.filter((child) => child !== id);

			for (const other of referrers)
				for (const [field, spec] of Object.entries(fieldsOf(state.nodes[other].type)))
					if (spec.kind === Kind.REFERENCES && state.nodes[other][field] !== undefined)
						state.nodes[other][field] =
							state.nodes[other][field].filter((target) => going.has(target) === false);

			for (const gone of going)
				delete state.nodes[gone];

			state.selection = {
				active: state.selection.active === null || going.has(state.selection.active)
					? parent.id
					: state.selection.active,
				ids: state.selection.ids.filter((selected) => going.has(selected) === false),
			};

			if (state.selection.ids.length === 0)
				state.selection.ids = [state.selection.active];
		},
	};
}


/**
 * Moves a node to another parent, or to another position under the same one.
 *
 * One implementation for both, which is why the outliner needs a drag and not a
 * pair of move-up/move-down buttons.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node to move
 * @param {String} parentId - where it should end up
 * @param {Number} [index] - position among that parent's children; appended by default
 * @returns {Object} a command
 * @throws {TypeError} when the move would detach the tree or make a cycle
 */
export function moveNode(document, id, parentId, index) {

	const node = document.nodes[id];
	const target = document.nodes[parentId];

	if (node === undefined || target === undefined)
		throw new TypeError(`No node "${node === undefined ? id : parentId}" in the document`);

	if (id === document.root)
		throw new TypeError('The project node cannot be moved');

	// moving a node into its own subtree would detach that subtree from the
	// document entirely, and it would still be reachable from itself
	if (descendantsOf(document, id).includes(parentId))
		throw new TypeError(`Cannot move ${node.name} into itself`);

	const from = parentOf(document, id);

	if (from === null)
		throw new TypeError(`${id} has no parent, so it is not attached to the document`);

	const touches = from.id === parentId ? [parentId] : [from.id, parentId];

	return {
		label: from.id === parentId ? `Reorder ${node.type.toLowerCase()}` : `Move ${node.type.toLowerCase()}`,
		touches,
		apply: (state) => {

			state.nodes[from.id].children =
				state.nodes[from.id].children.filter((child) => child !== id);

			const children = state.nodes[parentId].children;
			const at = index ?? children.length;

			children.splice(Math.max(0, Math.min(at, children.length)), 0, id);
		},
	};
}


/**
 * Sets a parent's children to an exact order.
 *
 * For the Jobs folder this is the order the machine cuts in, so it is a real
 * edit and not a cosmetic one.
 *
 * @param {Object} document - the project document
 * @param {String} parentId - the parent
 * @param {String[]} order - its children, rearranged
 * @returns {Object} a command
 * @throws {TypeError} when the order is not a permutation of the current children
 */
export function reorderChildren(document, parentId, order) {

	const parent = document.nodes[parentId];

	if (parent === undefined)
		throw new TypeError(`No node "${parentId}" in the document`);

	const before = [...(parent.children ?? [])].sort();
	const after = [...order].sort();

	if (before.length !== after.length || before.some((id, i) => id !== after[i]))
		throw new TypeError(`Reordering ${parent.name} must keep exactly the same children`);

	return {
		label: 'Reorder',
		touches: [parentId],
		apply: (state) => { state.nodes[parentId].children = [...order]; },
	};
}


/**
 * Sets a reference list — the paths a job cuts, say.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node
 * @param {String} field - a field of kind REFERENCES
 * @param {String[]} targets - the ids it should point at
 * @returns {Object} a command
 * @throws {TypeError} for an unknown node or field, or a target that is not there
 */
export function setReferences(document, id, field, targets) {

	const node = document.nodes[id];

	if (node === undefined)
		throw new TypeError(`No node "${id}" in the document`);

	const spec = fieldSpec(node.type, field);

	if (spec?.kind !== Kind.REFERENCES)
		throw new TypeError(`${node.type}.${field} is not a reference list`);

	for (const target of targets)
		if (document.nodes[target] === undefined)
			throw new TypeError(`Cannot point ${node.name} at "${target}", which is not in the document`);

	return {
		label: `Set ${spec.label.toLowerCase()}`,
		touches: [id],
		apply: (state) => { state.nodes[id][field] = [...targets]; },
	};
}


/**
 * Every node holding a reference to any of these ids.
 *
 * @param {Object} document - the project document
 * @param {Set<String>} targets - the ids being looked for
 * @returns {String[]} ids of the nodes that refer to them
 */
function referrersTo(document, targets) {

	/** @type {String[]} */
	const found = [];

	for (const node of Object.values(document.nodes))
		for (const [field, spec] of Object.entries(fieldsOf(node.type)))
			if (spec.kind === Kind.REFERENCES
				&& (node[field] ?? []).some((target) => targets.has(target))
				&& found.includes(node.id) === false)
				found.push(node.id);

	return found;
}


/**
 * A parent index, exported so a caller building several commands can share one.
 *
 * @param {Object} document - the project document
 * @returns {Map<String, String>} child id to parent id
 */
export { parentIndex };
