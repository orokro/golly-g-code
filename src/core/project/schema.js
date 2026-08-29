/**
 * @file schema.js
 * @description Valibot schemas, built from the field table rather than beside it.
 *
 * Every schema here is DERIVED from `FIELDS` in nodes.js. Writing them out by
 * hand would be the same facts recorded twice, and the copy that goes stale is
 * always the one that is not the source of the defaults — so a range would be
 * enforced that no control could produce, or a control would offer an option the
 * validator rejects, and neither would fail until somebody typed the wrong thing
 * into the right box.
 *
 * Inheritable fields are `optional`, because absent is what inheritance MEANS
 * (see inherit.js). A schema that required them would reject every correctly
 * built node.
 *
 * This validates VALUES. `validateTree` in tree.js validates the shape. They are
 * separate because they fail for different reasons and at different times: a bad
 * value comes from a control or a hand-edited file, a bad shape comes from a
 * command that got its bookkeeping wrong.
 */

import * as v from 'valibot';

import { Kind, FIELDS, fieldsOf } from './nodes.js';

/**
 * The Valibot schema for one field.
 *
 * @param {Object} spec - the field spec
 * @returns {Object} a Valibot schema
 * @throws {TypeError} when the spec has a kind this does not know
 */
function schemaForField(spec) {

	switch (spec.kind) {

		case Kind.TEXT:
			return v.string();

		case Kind.BOOLEAN:
			return v.boolean();

		case Kind.SELECT:
			return v.picklist(spec.options);

		case Kind.REFERENCES:
			// that the ids point at nodes that exist is a SHAPE question, and
			// belongs with the other shape questions in validateTree
			return v.array(v.pipe(v.string(), v.minLength(1)));

		case Kind.VECTOR2:
			return v.object({
				x: v.pipe(v.number(), v.finite()),
				y: v.pipe(v.number(), v.finite()),
			});

		case Kind.NUMBER: {

			/** @type {Object[]} finite first — NaN passes every range check there is */
			const checks = [v.finite()];

			if (spec.min !== undefined)
				checks.push(v.minValue(spec.min));

			if (spec.max !== undefined)
				checks.push(v.maxValue(spec.max));

			return v.pipe(v.number(), ...checks);
		}

		default:
			throw new TypeError(`No schema for field kind "${spec.kind}"`);
	}
}


/**
 * The schema for a node type.
 *
 * @param {String} type - a node type
 * @returns {Object} a Valibot object schema
 */
function schemaForType(type) {

	/** @type {Object<String, Object>} */
	const entries = {
		id: v.pipe(v.string(), v.minLength(1)),
		type: v.literal(type),
	};

	for (const [field, spec] of Object.entries(fieldsOf(type))) {
		const schema = schemaForField(spec);
		entries[field] = spec.inherit === undefined ? schema : v.optional(schema);
	}

	// only the types that may hold children have the array at all, and a node
	// that grew one it should not have is a shape problem, not a value one
	entries.children = v.optional(v.array(v.pipe(v.string(), v.minLength(1))));

	return v.object(entries);
}


/**
 * Every node type's schema, by type.
 *
 * @type {Object<String, Object>}
 */
export const SCHEMAS = Object.freeze(Object.fromEntries(
	Object.keys(FIELDS).map((type) => [type, schemaForType(type)])));


/**
 * Checks one node's values.
 *
 * @param {Object} node - the node
 * @returns {String[]} descriptions, empty when it is valid
 */
export function validateNode(node) {

	const schema = SCHEMAS[node?.type];

	if (schema === undefined)
		return [`unknown node type "${node?.type}"`];

	const result = v.safeParse(schema, node);

	if (result.success)
		return [];

	return result.issues.map((issue) => `${v.getDotPath(issue) ?? '?'}: ${issue.message}`);
}


/**
 * Checks every node in a document.
 *
 * @param {Object} document - the project document
 * @returns {Array<{id: String, issues: String[]}>} one entry per invalid node
 */
export function validateDocument(document) {

	/** @type {Array<{id: String, issues: String[]}>} */
	const bad = [];

	for (const node of Object.values(document.nodes)) {

		const issues = validateNode(node);

		if (issues.length > 0)
			bad.push({ id: node.id, issues });
	}

	return bad;
}


/**
 * Checks one value against the field it is destined for.
 *
 * What a command uses before writing, and what the Inspector uses to block a
 * commit and show the error inline rather than letting an out-of-range feed rate
 * reach the post-processor.
 *
 * @param {String} type - a node type
 * @param {String} field - the field name
 * @param {*} value - the proposed value
 * @returns {String[]} descriptions, empty when it is acceptable
 * @throws {TypeError} when that type has no such field
 */
export function validateValue(type, field, value) {

	const spec = fieldsOf(type)[field];

	if (spec === undefined)
		throw new TypeError(`${type} has no field "${field}"`);

	const result = v.safeParse(schemaForField(spec), value);

	return result.success ? [] : result.issues.map((issue) => issue.message);
}
