/**
 * @file rows.js
 * @description The outliner's tree, flattened, and where a drag would land.
 *
 * A tree drawn as a FLAT LIST of rows with an indent level, rather than nested
 * components. The tree is nested; the widget is not, and pretending otherwise
 * makes every hard part harder — a drop between two rows at different depths, a
 * shift-click range across a collapsed branch, keyboard navigation, and the
 * virtualisation this will eventually want for a drawing with a thousand paths.
 * All of those are trivial over an array and awkward over a recursion.
 *
 * Everything here is pure, and that is the point: `resolveDrop` is the only
 * genuinely fiddly logic in the outliner, and fiddly logic inside a pointer
 * handler inside a component is logic that gets verified by dragging things
 * around and squinting.
 */

import { NodeType, ALLOWED_CHILDREN } from '@core/project/nodes.js';
import { DepthClass } from '@core/project/diagnostics.js';
import { parentIndex, parentOf, descendantsOf, isVisible, isLocked } from '@core/project/tree.js';

/** Where a drop would put the dragged node, relative to the row under the cursor. */
export const Drop = Object.freeze({

	/** Inside the row's node, as a child. */
	INTO: 'into',

	/** As a sibling immediately before it. */
	BEFORE: 'before',

	/** As a sibling immediately after it. */
	AFTER: 'after',
});

/**
 * Where a between-rows drop puts things, relative to the row under the cursor.
 *
 * Half and half. There is no middle band, because there is nothing for one to
 * mean — see `resolveDrop`.
 */
export const SPLIT_FRACTION = 0.5;


/**
 * @typedef {Object} Row
 * @property {String} id - the node's id
 * @property {Object} node - the node itself
 * @property {Number} depth - how far to indent, the project being 0
 * @property {Boolean} hasChildren - whether it can be expanded
 * @property {Boolean} expanded - whether it is
 * @property {Boolean} visible - after inheriting from its ancestors
 * @property {Boolean} locked - after inheriting from its ancestors
 */


/**
 * Flattens the tree into the rows the outliner draws.
 *
 * @param {Object} document - the project document
 * @param {Set<String>} collapsed - ids whose children are hidden. Collapsed
 *   rather than expanded, so a newly imported drawing shows its paths without
 *   anything having to remember to open it
 * @returns {Row[]} in display order
 */
export function flattenTree(document, collapsed = new Set()) {

	const index = parentIndex(document);

	/** @type {Row[]} */
	const rows = [];

	/**
	 * Adds a node and, unless it is collapsed, everything under it.
	 *
	 * @param {String} id - the node
	 * @param {Number} depth - its indent level
	 */
	const walk = (id, depth) => {

		const node = document.nodes[id];

		if (node === undefined)
			return;

		const children = node.children ?? [];
		const expanded = collapsed.has(id) === false;

		rows.push({
			id,
			node,
			depth,
			hasChildren: children.length > 0,
			expanded,
			visible: isVisible(document, id, index),
			locked: isLocked(document, id, index),
		});

		if (expanded)
			for (const child of children)
				walk(child, depth + 1);
	};

	walk(document.root, 0);

	return rows;
}


/**
 * Whether a node may be dropped inside another.
 *
 * The hierarchy is fixed (see ALLOWED_CHILDREN), so most drags are simply not
 * possible — a Tab into the SVGs folder, a Job outside a Tool. Saying so while
 * the pointer is still moving is much kinder than accepting the drop and then
 * refusing it.
 *
 * @param {Object} document - the project document
 * @param {String} dragId - what is being dragged
 * @param {String} parentId - the proposed parent
 * @returns {Boolean} true when the move is allowed
 */
export function canDropInto(document, dragId, parentId) {

	const dragged = document.nodes[dragId];
	const parent = document.nodes[parentId];

	if (dragged === undefined || parent === undefined)
		return false;

	if ((ALLOWED_CHILDREN[parent.type] ?? []).includes(dragged.type) === false)
		return false;

	// into itself or into its own subtree would detach that subtree from the
	// document while leaving it reachable from itself
	return descendantsOf(document, dragId).includes(parentId) === false;
}


/**
 * Works out where a drag would actually land.
 *
 * ---------------------------------------------------------------------------
 * Why there is no middle band
 *
 * The obvious design for a tree drop is three zones per row: top edge means
 * "before", bottom edge means "after", and the middle means "inside". That is
 * right for a tree where anything can contain anything.
 *
 * This one is strictly layered — a Job goes in a Tool, a Tab goes in a Job,
 * an SvgPath goes in an SvgDoc — and the consequence is that for ANY pair of
 * types, dropping inside a row and dropping next to it are never both legal.
 * A Job can go inside a Tool but not beside one; it can go beside another Job
 * but not inside one. So a row is either a container for the thing you are
 * dragging or a neighbour of it, and the cursor's position within the row
 * cannot change which.
 *
 * Three zones would therefore have been two dead ones on every row: an edge
 * band that resolves to "inside" anyway on a container, and a middle band that
 * resolves to "after" anyway on a neighbour. The first version of this had
 * exactly that, and a test asserting the boundary failed because there was no
 * boundary to assert. There is a test below pinning the property this rests on.
 * ---------------------------------------------------------------------------
 *
 * Returns null when the drop is not allowed, which is what the caller shows as
 * a no-entry cursor rather than a drop line.
 *
 * @param {Object} options - options
 * @param {Object} options.document - the project document
 * @param {Row[]} options.rows - the flattened tree
 * @param {String} options.dragId - the node being dragged
 * @param {Number} options.overIndex - index into `rows` of the row under the cursor
 * @param {Number} options.fraction - how far down that row, 0 at the top, 1 at the bottom
 * @returns {Object|null} `{ parentId, index, kind, overId }`, or null
 */
export function resolveDrop(options) {

	const { document, rows, dragId, overIndex, fraction } = options;
	const over = rows[overIndex];

	if (over === undefined || over.id === dragId)
		return null;

	if (canDropInto(document, dragId, over.id))
		return {
			parentId: over.id,
			index: (document.nodes[over.id].children ?? []).length,
			kind: Drop.INTO,
			overId: over.id,
		};

	return sibling(document, dragId, over, fraction < SPLIT_FRACTION ? Drop.BEFORE : Drop.AFTER);
}

/**
 * Turns a between-rows drop into a parent and an index.
 *
 * @param {Object} document - the project document
 * @param {String} dragId - the node being dragged
 * @param {Row} over - the row under the cursor
 * @param {String} kind - {@link Drop}.BEFORE or AFTER
 * @returns {Object|null} the resolved drop, or null when it is not allowed
 */
function sibling(document, dragId, over, kind) {

	const parent = parentOf(document, over.id);

	if (parent === null || canDropInto(document, dragId, parent.id) === false)
		return null;

	const children = parent.children ?? [];
	const at = children.indexOf(over.id);

	return {
		parentId: parent.id,
		index: kind === Drop.BEFORE ? at : at + 1,
		kind,
		overId: over.id,
	};
}


/**
 * Adjusts a drop index for a node that is already in that parent.
 *
 * Moving a node down within its own parent removes it before it is reinserted,
 * so every index after its old position has shifted by one. Without this, a
 * drag of one place down does nothing at all and looks like a bug in the drag
 * rather than in the arithmetic.
 *
 * @param {Object} document - the project document
 * @param {String} dragId - the node being moved
 * @param {Object} drop - what `resolveDrop` returned
 * @returns {Number} the index to pass to `moveNode`
 */
export function adjustedIndex(document, dragId, drop) {

	const parent = document.nodes[drop.parentId];
	const from = (parent?.children ?? []).indexOf(dragId);

	return from >= 0 && from < drop.index ? drop.index - 1 : drop.index;
}


/**
 * The rows a shift-click should select.
 *
 * Over the FLAT list, so a range crosses branches the way it looks like it
 * should on screen rather than following the tree.
 *
 * @param {Row[]} rows - the flattened tree
 * @param {String} anchorId - where the range started
 * @param {String} toId - where it ends
 * @returns {String[]} the ids in the range, in display order
 */
export function rangeBetween(rows, anchorId, toId) {

	const a = rows.findIndex((row) => row.id === anchorId);
	const b = rows.findIndex((row) => row.id === toId);

	if (a < 0 || b < 0)
		return b < 0 ? [] : [toId];

	return rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((row) => row.id);
}


/**
 * What a click with modifiers should make the selection.
 *
 * @param {Object} options - options
 * @param {Row[]} options.rows - the flattened tree
 * @param {String[]} options.selected - what is selected now
 * @param {String|null} options.anchorId - the last plain click, for shift ranges
 * @param {String} options.id - what was clicked
 * @param {Boolean} [options.toggle] - ctrl or cmd was held
 * @param {Boolean} [options.range] - shift was held
 * @returns {Object} `{ ids, active, anchorId }`
 */
export function clickSelection(options) {

	const { rows, selected, anchorId, id, toggle = false, range = false } = options;

	if (range)
		return { ids: rangeBetween(rows, anchorId ?? id, id), active: id, anchorId };

	if (toggle) {

		const already = selected.includes(id);
		const ids = already ? selected.filter((each) => each !== id) : [...selected, id];

		// deselecting the active node leaves the last of what remains active, and
		// never leaves nothing active while something is still selected
		return { ids, active: already ? ids.at(-1) ?? null : id, anchorId: id };
	}

	return { ids: [id], active: id, anchorId: id };
}


/**
 * Rounds for a row, without a unit on every number.
 *
 * @param {Number} value - millimetres
 * @returns {String} two decimals
 */
const mm = (value) => value.toFixed(2);


/**
 * A short line describing a node, drawn under its name.
 *
 * Only jobs get one — it is the depth, and it is the whole mechanism for
 * noticing that changing the stock changed what every job does. Everything else
 * is one line, so the list stays readable.
 *
 * COMPACT, not the diagnostic's sentence. An outliner row is about 170 pixels
 * of text at the depth a job sits at, and "Cuts 1.00mm of 4.00mm — 3.00mm left
 * below." is half as wide again as that, so it would arrive permanently
 * ellipsised and the numbers — the entire point — would be the part cut off.
 * Built from the diagnostic's `data` rather than by trimming its message,
 * because reformatting that string would be parsing our own prose. The full
 * sentence is still there as the row's tooltip; see `detailTitle`.
 *
 * @param {Object} node - the node
 * @param {Array} diagnostics - this node's diagnostics, from `byNode`
 * @returns {String|null} the line, or null when the row is a single line
 */
export function detailLine(node, diagnostics = []) {

	if (node.type !== NodeType.JOB)
		return null;

	const data = diagnostics.find((d) => d.code.startsWith('depth-'))?.data;

	if (data === undefined)
		return null;

	if (data.depthClass === DepthClass.GROOVE)
		return `${mm(data.cutDepth)} of ${mm(data.thickness)}mm · ${mm(data.remaining)} left`;

	if (data.depthClass === DepthClass.THROUGH)
		return `through ${mm(data.thickness)}mm · +${mm(data.into)}`;

	return `${mm(data.past)}mm past the allowance`;
}


/**
 * The full sentences for a node, for its tooltip.
 *
 * @param {Array} diagnostics - this node's diagnostics, from `byNode`
 * @returns {String} one per line, empty when there are none
 */
export function detailTitle(diagnostics = []) {
	return diagnostics.map((d) => d.message).join('\n');
}
