/**
 * @file inherit.js
 * @description Live-linked inheritance: where a field's value actually comes from.
 *
 * A Job does not store a copy of its Tool's feed rate. It stores nothing at all
 * for that field until you disagree with the tool, and the value is looked up
 * every time it is needed. Correcting the tool therefore corrects every job that
 * never disagreed — including jobs made before the correction, which is the
 * whole point and the thing copy-at-creation cannot do.
 *
 * Absent means inherited. That is why `createNode` leaves inheritable fields out
 * rather than filling in the default: a job created with `passDepth: 1` written
 * into it looks identical to an inherited one and behaves completely differently
 * six months later.
 *
 * It also decides what the Inspector shows. A field resolving to `INHERITED`
 * renders in the distinct state with "uses the tool's value", and its reset
 * button DELETES the key — restoring the link, not writing today's tool value
 * into the job.
 */

import { fieldsOf, fieldSpec } from './nodes.js';
import { parentIndex, ancestorOfType } from './tree.js';

/** Where a resolved value came from. */
export const Source = Object.freeze({

	/** The node says so itself. An override, or a field that cannot be inherited. */
	OWN: 'own',

	/** Taken live from an ancestor. */
	INHERITED: 'inherited',

	/** Nothing said, and nothing to inherit from — the field spec's default. */
	DEFAULT: 'default',
});


/**
 * @typedef {Object} Resolved
 * @property {*} value - the value to use
 * @property {String} source - one of {@link Source}
 * @property {String|null} from - the node the value came from, when inherited
 * @property {Object} spec - the field's spec, so a caller need not look it up again
 */


/**
 * Works out a single field's value and where it came from.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node
 * @param {String} field - the field name
 * @param {Map<String, String>} [index] - a prebuilt parent index
 * @returns {Resolved} the value and its provenance
 * @throws {TypeError} for an unknown node, or a field that type does not define
 */
export function resolveField(document, id, field, index = parentIndex(document)) {

	const node = document.nodes[id];

	if (node === undefined)
		throw new TypeError(`No node "${id}" in the document`);

	const spec = fieldSpec(node.type, field);

	if (spec === null)
		throw new TypeError(`${node.type} has no field "${field}"`);

	if (node[field] !== undefined)
		return { value: node[field], source: Source.OWN, from: null, spec };

	if (spec.inherit === undefined)
		return { value: spec.default, source: Source.DEFAULT, from: null, spec };

	const ancestor = ancestorOfType(document, id, spec.inherit.from, index);

	if (ancestor === null)
		return { value: spec.default, source: Source.DEFAULT, from: null, spec };

	// resolve ON the ancestor rather than reading its property, so a chain of
	// inheritance works and so an ancestor that is itself defaulting says so
	const up = resolveField(document, ancestor.id, spec.inherit.field, index);

	return { value: up.value, source: Source.INHERITED, from: ancestor.id, spec };
}


/**
 * Every field of a node, resolved, with provenance.
 *
 * This is what the Inspector renders from: one pass gives it the value, the
 * control to draw, and whether to show the inherited state.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node
 * @param {Map<String, String>} [index] - a prebuilt parent index
 * @returns {Object<String, Resolved>} by field name
 * @throws {TypeError} when there is no such node
 */
export function resolveNode(document, id, index = parentIndex(document)) {

	const node = document.nodes[id];

	if (node === undefined)
		throw new TypeError(`No node "${id}" in the document`);

	return Object.fromEntries(Object.keys(fieldsOf(node.type))
		.map((field) => [field, resolveField(document, id, field, index)]));
}


/**
 * Every field of a node, as plain values.
 *
 * What the CAM core wants: `generateToolpath` takes settings, not provenance.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node
 * @param {Map<String, String>} [index] - a prebuilt parent index
 * @returns {Object<String, *>} by field name
 */
export function resolvedValues(document, id, index = parentIndex(document)) {

	return Object.fromEntries(Object.entries(resolveNode(document, id, index))
		.map(([field, resolved]) => [field, resolved.value]));
}


/**
 * Which of a node's fields are its own opinion rather than inherited.
 *
 * The Inspector's "reset" affordance appears for exactly these.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node
 * @returns {String[]} the overridden field names
 */
export function overridesOf(document, id) {

	const node = document.nodes[id];

	if (node === undefined)
		return [];

	return Object.entries(fieldsOf(node.type))
		.filter(([field, spec]) => spec.inherit !== undefined && node[field] !== undefined)
		.map(([field]) => field);
}


/**
 * Which nodes would change if a field on this one changed.
 *
 * The other direction: a Tool's cut feed is used by every job under it that has
 * not overridden it. Needed for `touches` when editing an inheritable field, and
 * for invalidating the right G-code in 5.2 — changing a tool's feed makes its
 * jobs stale, and changing it makes exactly the non-overriding ones stale.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node whose field changed
 * @param {String} field - the field name
 * @returns {String[]} ids of nodes that resolve that field through this one
 */
export function dependentsOf(document, id, field) {

	const index = parentIndex(document);

	/** @type {String[]} */
	const found = [];

	for (const other of Object.values(document.nodes)) {

		if (other.id === id)
			continue;

		const spec = fieldSpec(other.type, field);

		if (spec?.inherit === undefined || spec.inherit.field !== field)
			continue;

		const resolved = resolveField(document, other.id, field, index);

		if (resolved.source === Source.INHERITED && resolved.from === id)
			found.push(other.id);
	}

	return found;
}
