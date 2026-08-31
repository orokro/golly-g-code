/**
 * @file layout.js
 * @description What the Inspector shows, for whatever is selected.
 *
 * The field TABLE lives in core (`nodes.js`) and says what each field is — its
 * kind, its range, what it inherits from. This file says where each one is
 * DRAWN, which is a presentation question and belongs on this side of the fence.
 * Core describes the document; the renderer decides how to look at it.
 *
 * That is two tables that could drift, so there is a test asserting every field
 * of every type appears in exactly one group and every grouped field exists. A
 * field added to core and forgotten here would otherwise simply be invisible —
 * no error, no gap on screen, just a setting nobody can reach.
 *
 * ---------------------------------------------------------------------------
 * A selection is a LIST, always
 *
 * Even one node. The Inspector has to handle several selected at once — that is
 * what makes "Create Job from Paths" with a combine mode possible at all — and a
 * single-selection path written first and generalised later is how you end up
 * with two renderers and one of them wrong. So everything here takes ids, and
 * one id is just the easy case.
 *
 * Several nodes of the same type show that type's fields, with any field they
 * disagree on marked MIXED rather than showing whichever one happened to be
 * first. Several nodes of different types show only what they all have — the
 * name, the lock, the eyeball — because there is nothing else honest to show.
 * ---------------------------------------------------------------------------
 */

import { NodeType, fieldsOf } from '@core/project/nodes.js';
import { resolveField, Source } from '@core/project/inherit.js';
import { parentIndex } from '@core/project/tree.js';

/**
 * Stands for "these nodes disagree".
 *
 * A symbol, so it can never collide with a real value — `'mixed'` is a perfectly
 * good name for a tool.
 */
export const MIXED = Symbol('mixed');

/**
 * Which fields go in which group, in order, per node type.
 *
 * The order is the reading order: what the thing IS, then what it does, then the
 * details. `general` is last everywhere because a node's name and its lock are
 * the least interesting things about it once you have found it in the outliner.
 *
 * @type {Object<String, Array<{name: String, fields: String[]}>>}
 */
export const GROUPS = Object.freeze({

	[NodeType.PROJECT]: [
		{ name: 'Material', fields: ['materialThickness', 'cutThroughAllowance'] },
		{ name: 'Machine', fields: ['workspaceWidth', 'workspaceHeight', 'zTravel', 'workZero', 'safeZ', 'rapidRate', 'toolChange', 'spindleDwell'] },
		{ name: 'Tab defaults', fields: ['defaultTabLength', 'defaultTabDepth'] },
		{ name: 'General', fields: ['name', 'locked', 'visible'] },
	],

	[NodeType.FOLDER]: [
		{ name: 'General', fields: ['name', 'role', 'locked', 'visible'] },
	],

	[NodeType.TOOL]: [
		{ name: 'Cutter', fields: ['diameter', 'angle', 'flutes'] },
		{ name: 'Feeds and speeds', fields: ['passDepth', 'stepover', 'plungeRate', 'cutFeed', 'spindleRpm'] },
		{ name: 'General', fields: ['name', 'locked', 'visible'] },
	],

	[NodeType.JOB]: [
		{ name: 'Cut', fields: ['paths', 'operation', 'cutDepth', 'margin', 'width', 'combine', 'direction'] },
		{ name: 'Open paths', fields: ['offsetSide', 'offsetHeading'] },
		{ name: 'Entry and exit', fields: ['ramp', 'rampAngle', 'leadIn', 'leadOut', 'leadSide'] },
		{ name: 'Feeds and speeds', fields: ['passDepth', 'stepover', 'plungeRate', 'cutFeed', 'spindleRpm'] },
		{ name: 'Corners', fields: ['dogbones'] },
		{ name: 'General', fields: ['name', 'locked', 'visible'] },
	],

	[NodeType.TAB]: [
		{ name: 'Tab', fields: ['position', 'length', 'depth'] },
		{ name: 'General', fields: ['name', 'locked', 'visible'] },
	],

	[NodeType.SVG_DOC]: [
		{ name: 'Source', fields: ['source'] },
		{ name: 'General', fields: ['name', 'locked', 'visible'] },
	],

	[NodeType.SVG_PATH]: [
		{ name: 'Path', fields: ['closed', 'geometry'] },
		{ name: 'General', fields: ['name', 'locked', 'visible'] },
	],

	[NodeType.REFERENCE_IMAGE]: [
		{ name: 'Image', fields: ['asset', 'opacity', 'rotation', 'scale', 'scaleLocked'] },
		{ name: 'General', fields: ['name', 'locked', 'visible'] },
	],

	[NodeType.WORK_MATERIAL]: [
		{ name: 'Stock', fields: ['paths'] },
		{ name: 'General', fields: ['name', 'locked', 'visible'] },
	],
});

/**
 * What to call each node type in a sentence.
 *
 * The type names are identifiers — `SvgPath`, `WorkMaterial` — and lowercasing
 * one gets you "2 svgpaths", which is nobody's word for anything. These are.
 *
 * @type {Object<String, String>}
 */
export const TYPE_LABEL = Object.freeze({
	[NodeType.PROJECT]: 'project',
	[NodeType.FOLDER]: 'folder',
	[NodeType.TOOL]: 'tool',
	[NodeType.JOB]: 'job',
	[NodeType.TAB]: 'tab',
	[NodeType.SVG_DOC]: 'drawing',
	[NodeType.SVG_PATH]: 'path',
	[NodeType.REFERENCE_IMAGE]: 'reference image',
	[NodeType.WORK_MATERIAL]: 'stock outline',
});

/** Fields nobody may type into, whatever their kind. */
const READ_ONLY = Object.freeze(['geometry', 'asset', 'role', 'closed']);


/**
 * @typedef {Object} InspectorField
 * @property {String} field - the field name
 * @property {Object} spec - its FieldSpec from core
 * @property {*} value - the resolved value, or {@link MIXED}
 * @property {String} source - one of {@link Source}, or `mixed`
 * @property {String|null} from - the node an inherited value came from
 * @property {Boolean} overridden - true when this node has its own value for an
 *   inheritable field, which is what puts a reset button next to it
 * @property {Boolean} readOnly - true when it is shown but not editable
 */


/**
 * Everything the Inspector should draw for a selection.
 *
 * @param {Object} document - the project document
 * @param {String[]} ids - what is selected
 * @returns {Object} `{ type, nodes, title, groups }`; `groups` is empty when
 *   there is nothing selected
 */
export function inspectorLayout(document, ids) {

	const nodes = ids.map((id) => document.nodes[id]).filter((node) => node !== undefined);

	if (nodes.length === 0)
		return { type: null, nodes, title: 'Nothing selected', groups: [] };

	const types = new Set(nodes.map((node) => node.type));
	const type = types.size === 1 ? nodes[0].type : null;
	const index = parentIndex(document);

	const groups = (type === null ? mixedTypeGroups(nodes) : GROUPS[type])
		.map((group) => ({
			name: group.name,
			fields: group.fields
				.filter((field) => nodes.every((node) => fieldsOf(node.type)[field] !== undefined))
				.filter((field) => shadowsWithin(document, nodes, field, index) === false)
				.map((field) => describe(document, nodes, field, index)),
		}))
		.filter((group) => group.fields.length > 0);

	return { type, nodes, title: titleFor(nodes, type), groups };
}


/**
 * Whether one selected node inherits this field from another selected node.
 *
 * The trap this exists to close: select a Tool and one of its Jobs, and both
 * genuinely have a `cutFeed` — the tool's is the source and the job's is the
 * override of it. Offering one control for the pair would set both, which
 * quietly gives the job an override it did not have, so correcting the tool
 * later would no longer move that job. The user would have broken the link by
 * editing a field that said nothing about links.
 *
 * Two jobs under different tools are not this case: neither inherits from the
 * other, so editing them together is an ordinary multi-edit and the field stays.
 *
 * @param {Object} document - the project document
 * @param {Object[]} nodes - the selected nodes
 * @param {String} field - the field name
 * @param {Map} index - a prebuilt parent index
 * @returns {Boolean} true when the field should be left out
 */
function shadowsWithin(document, nodes, field, index) {

	if (nodes.length < 2)
		return false;

	const selected = new Set(nodes.map((node) => node.id));

	return nodes.some((node) => {

		const resolved = resolveField(document, node.id, field, index);

		return resolved.source === Source.INHERITED && selected.has(resolved.from);
	});
}


/**
 * What to call the selection.
 *
 * @param {Object[]} nodes - the selected nodes
 * @param {String|null} type - their common type, or null
 * @returns {String} a heading
 */
function titleFor(nodes, type) {

	if (nodes.length === 1)
		return nodes[0].name;

	return type === null
		? `${nodes.length} items`
		: `${nodes.length} ${TYPE_LABEL[type] ?? type.toLowerCase()}s`;
}


/**
 * The groups to show when the selection is of mixed types.
 *
 * Only what every node genuinely has. Showing a Job's cut depth because most of
 * the selection happens to be jobs would be a control that silently does nothing
 * to the rest of it.
 *
 * @param {Object[]} nodes - the selected nodes
 * @returns {Array} one group
 */
function mixedTypeGroups(nodes) {

	const common = Object.keys(fieldsOf(nodes[0].type))
		.filter((field) => nodes.every((node) => fieldsOf(node.type)[field] !== undefined));

	return [{ name: 'General', fields: common }];
}


/**
 * Resolves one field across every selected node.
 *
 * @param {Object} document - the project document
 * @param {Object[]} nodes - the selected nodes
 * @param {String} field - the field name
 * @param {Map} index - a prebuilt parent index
 * @returns {InspectorField} what to draw
 */
function describe(document, nodes, field, index) {

	const resolved = nodes.map((node) => resolveField(document, node.id, field, index));
	const [first] = resolved;
	const agree = resolved.every((each) => same(each.value, first.value));
	const sameSource = resolved.every((each) => each.source === first.source && each.from === first.from);

	return {
		field,
		spec: first.spec,
		value: agree ? first.value : MIXED,
		source: sameSource ? first.source : 'mixed',
		from: sameSource ? first.from : null,
		overridden: nodes.some((node) => first.spec.inherit !== undefined && node[field] !== undefined),
		readOnly: READ_ONLY.includes(field),
	};
}


/**
 * Whether two field values are the same for the purpose of showing one control.
 *
 * Handles the shapes a FieldSpec value can take: a scalar, a `{x, y}`, or a list
 * of ids. Not a general deep-equal — it only has to cover what the table can
 * hold, and a general one would quietly start being used for things it was never
 * checked against.
 *
 * @param {*} a - one value
 * @param {*} b - the other
 * @returns {Boolean} true when a single control can represent both
 */
function same(a, b) {

	if (a === b)
		return true;

	if (Array.isArray(a) && Array.isArray(b))
		return a.length === b.length && a.every((each, i) => each === b[i]);

	if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object')
		return a.x === b.x && a.y === b.y;

	return false;
}


/**
 * Whether a field is currently meaningful for a job.
 *
 * The open-path fields mean nothing on a closed-path operation and the other way
 * about, and a band width means nothing to a centre cut. Rather than hide them —
 * a control that vanishes is a control you cannot find again — they are dimmed,
 * so the panel's shape stays the same while you change the operation.
 *
 * @param {Object} node - the node
 * @param {String} field - the field name
 * @param {Object} values - the node's resolved values
 * @returns {Boolean} false when the field has no effect right now
 */
export function isRelevant(node, field, values) {

	if (node?.type !== NodeType.JOB)
		return true;

	// heading offset displaces the whole path in ONE fixed direction, so it is the
	// only mode with an angle; normal offset follows the path's own normals and
	// only needs to know which side
	if (field === 'offsetSide')
		return values.operation === 'normal' || values.operation === 'heading';

	if (field === 'offsetHeading')
		return values.operation === 'heading';

	if (field === 'rampAngle')
		return values.ramp === true;

	if (field === 'leadSide')
		return values.leadIn > 0 || values.leadOut > 0;

	if (field === 'width')
		return values.operation === 'inside' || values.operation === 'outside';

	if (field === 'stepover')
		return values.operation === 'pocket' || values.width > 0;

	return true;
}
