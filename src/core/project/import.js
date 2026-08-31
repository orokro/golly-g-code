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
import { boundsOfSubPaths, unionBounds, sizeOf } from '../path/bounds.js';
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
	const measured = measure(imported);

	const doc = createNode(NodeType.SVG_DOC, {
		name: filename,
		source,
		...measured,
	}, { newId });

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
 * What an import turned out to be, as fields for the SvgDoc node.
 *
 * The size is the artwork's own bounding box rather than the document's stated
 * canvas, because it is the number that can be checked: you can measure the
 * thing you drew, and you cannot measure the whitespace around it. If it
 * disagrees with the ruler, the resolution was wrong.
 *
 * @param {Object} imported - what `importSvgDocument` returned
 * @returns {Object} `{ pixelsPerInch, dpiDependent, widthMm, heightMm, notes }`
 */
function measure(imported) {

	const box = unionBounds(imported.shapes.map((shape) => boundsOfSubPaths(shape.subPaths)));
	const { width, height } = sizeOf(box);

	return {
		pixelsPerInch: imported.viewport?.pixelsPerInch ?? 96,
		dpiDependent: imported.viewport?.dpiDependent === true,
		widthMm: round(width),
		heightMm: round(height),
		notes: imported.warnings.join('\n'),
	};
}

/**
 * Rounds a measured length to something worth storing.
 *
 * @param {Number} value - millimetres
 * @returns {Number} four decimals, which is far past what the machine resolves
 */
function round(value) {
	return Number(value.toFixed(4));
}


/**
 * Re-reads a drawing at a different resolution.
 *
 * The original SVG is kept verbatim precisely so this is possible: nothing is
 * re-parsed from our own output, and the result is exactly what a fresh import
 * at that resolution would have produced.
 *
 * The PATH NODES KEEP THEIR IDS. Only what they point at changes, so a job that
 * cuts one of them still cuts it — which is the whole reason to do this as a
 * re-read rather than as a delete and re-import. The old geometry is left
 * behind, unreferenced, and collected on save like anything else undo might
 * still want back.
 *
 * @param {Object} project - `{ document, geometry, sources }`
 * @param {String} docId - the SvgDoc node
 * @param {Object} options - options
 * @param {Number} options.pixelsPerInch - the resolution to read it at
 * @returns {Object} `{ command, geometry }` — dispatch the one, assign the other
 * @throws {Error} when the drawing is not there, or comes out a different shape
 */
export function prepareSvgReimport(project, docId, options) {

	const { pixelsPerInch } = options ?? {};
	const doc = project.document.nodes[docId];

	if (doc?.type !== NodeType.SVG_DOC)
		throw new Error(`"${docId}" is not an imported drawing.`);

	const text = project.sources?.[doc.source];

	if (typeof text !== 'string')
		throw new Error(`The original of ${doc.name} is not in this project, so it cannot be re-read.`);

	const imported = importSvgDocument(text, { pixelsPerInch });
	const children = doc.children ?? [];

	// the same file at a different resolution is the same shapes at a different
	// scale, so a different count means an assumption here is wrong and it is
	// better to say so than to guess which path became which
	if (imported.shapes.length !== children.length)
		throw new Error(
			`Re-reading ${doc.name} produced ${imported.shapes.length} shapes where the`
			+ ` project has ${children.length}.`);

	/** @type {Object<String, *>} */
	const geometry = {};

	/** @type {Object<String, String>} */
	const assigned = {};

	imported.shapes.forEach((shape, index) => {

		const id = `g-${children[index]}-${pixelsPerInch}`;

		geometry[id] = { subPaths: shape.subPaths, fillRule: shape.fillRule, tag: shape.tag };
		assigned[children[index]] = id;
	});

	const measured = measure(imported);

	return {
		geometry,
		command: {
			label: 'Set resolution',
			touches: [docId],
			coalesceKey: `resolution:${docId}`,
			apply: (state) => {

				Object.assign(state.nodes[docId], measured, { pixelsPerInch });

				for (const [pathId, geometryId] of Object.entries(assigned))
					state.nodes[pathId].geometry = geometryId;
			},
		},
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
