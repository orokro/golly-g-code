/**
 * @file import.js
 * @description Turning an imported SVG into project nodes and geometry.
 *
 * The bridge between `core/svg`, which knows how to read a drawing, and
 * `core/project`, which knows what a document is made of. Pure: text in, nodes
 * and geometry out, nothing dispatched and nothing mutated. The caller writes
 * the geometry into the project and dispatches the command.
 *
 * ---------------------------------------------------------------------------
 * One node per SHAPE, not per subpath
 *
 * A `<path d="M… Z M… Z">` — the letter O, a washer, anything with a hole — is
 * one shape with two subpaths, and they have to stay together. Split into two
 * nodes, "inside" on the outer contour would cut the hole away and "inside" on
 * the inner one would mean nothing at all, because which contour is a hole is a
 * property of the SET and not of either one alone.
 *
 * So an SvgPath node holds one shape, and its geometry entry holds every subpath
 * of it. `closed` is true only when EVERY subpath is closed, because a shape with
 * one open subpath cannot be treated as an area no matter what the others do.
 * ---------------------------------------------------------------------------
 *
 * Geometry does not go through the undo system — see document.js. The caller
 * assigns it before dispatching, and an import that is then undone leaves its
 * geometry behind on purpose: that is exactly what the redo wants, and the save
 * collects whatever is still unreferenced at the end.
 */

import { importSvgDocument } from '../svg/document.js';
import { NodeType, createNode } from './nodes.js';

/**
 * @typedef {Object} PreparedImport
 * @property {Object} doc - the SvgDoc node, with its SvgPath children attached
 * @property {Object[]} nodes - every node created, the SvgDoc first
 * @property {Object} geometry - new geometry entries, by id
 * @property {String[]} warnings - anything the importer had to say
 * @property {String} source - the key the original SVG text should be stored under
 */


/**
 * Reads an SVG into nodes and geometry, ready to be added to a document.
 *
 * @param {String} svgText - the file, as it was on disk
 * @param {Object} [options] - options
 * @param {String} [options.filename='drawing.svg'] - what it was called
 * @param {Function} [options.newId] - id factory, injectable so tests are deterministic
 * @param {Number} [options.pixelsPerInch] - forwarded to the importer, for a
 *   document that states no physical unit
 * @param {Object<String, *>} [options.existingSources] - sources already in the
 *   project, so a second import of the same name does not overwrite the first
 * @returns {PreparedImport} everything needed to add it
 * @throws {Error} when the SVG cannot be read at all
 */
export function prepareSvgImport(svgText, options = {}) {

	const {
		filename = 'drawing.svg',
		newId,
		pixelsPerInch,
		existingSources = {},
	} = options;

	const imported = importSvgDocument(svgText, pixelsPerInch === undefined ? {} : { pixelsPerInch });
	const source = uniqueName(filename, existingSources);

	const doc = createNode(NodeType.SVG_DOC, { name: filename, source }, { newId });

	/** @type {Object<String, *>} */
	const geometry = {};

	/** @type {Object[]} */
	const paths = imported.shapes.map((shape) => {

		const id = newId === undefined ? undefined : newId();
		const node = createNode(NodeType.SVG_PATH, {
			...(id === undefined ? {} : { id }),
			name: shape.label,
			closed: shape.subPaths.length > 0 && shape.subPaths.every((sub) => sub.closed),
		}, { newId });

		// the geometry is keyed by the node that owns it, which makes an orphaned
		// entry immediately recognisable when reading a file by hand
		node.geometry = `g-${node.id}`;

		geometry[node.geometry] = {
			subPaths: shape.subPaths,
			fillRule: shape.fillRule,
			tag: shape.tag,
		};

		return node;
	});

	doc.children = paths.map((node) => node.id);

	return {
		doc,
		nodes: [doc, ...paths],
		geometry,
		warnings: imported.warnings,
		source,
	};
}


/**
 * A name that is not already taken.
 *
 * Importing `logo.svg` twice must not have the second one silently replace the
 * first one's stored original — the whole point of keeping originals is that
 * they are still there.
 *
 * @param {String} name - the preferred name
 * @param {Object} taken - an object whose keys are the names in use
 * @returns {String} `name`, or `name (2)` and so on
 */
export function uniqueName(name, taken) {

	if (Object.hasOwn(taken, name) === false)
		return name;

	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : '';

	for (let n = 2; n < 1000; n += 1) {

		const candidate = `${stem} (${n})${extension}`;

		if (Object.hasOwn(taken, candidate) === false)
			return candidate;
	}

	throw new Error(`Could not find an unused name for "${name}".`);
}


/**
 * How many shapes, and how many of them are closed.
 *
 * For the message after an import — "12 paths, 3 open" tells you at a glance
 * whether the drawing is what you thought it was, which matters because an
 * accidentally-open contour is invisible on screen and changes every operation
 * that can be applied to it.
 *
 * @param {PreparedImport} prepared - what `prepareSvgImport` returned
 * @returns {Object} `{ total, closed, open }`
 */
export function summarise(prepared) {

	const paths = prepared.nodes.filter((node) => node.type === NodeType.SVG_PATH);
	const closed = paths.filter((node) => node.closed).length;

	return { total: paths.length, closed, open: paths.length - closed };
}
