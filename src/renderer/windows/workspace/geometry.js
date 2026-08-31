/**
 * @file geometry.js
 * @description Turning stored path data into something an `<svg>` can draw.
 *
 * ---------------------------------------------------------------------------
 * One `<path>` per object, and its `d` is built ONCE
 *
 * A drawing can be fifty thousand segments. Fifty thousand sibling elements is
 * a browser that stops responding; one element with a fifty-thousand-command `d`
 * is fine, because the work is in the rasteriser rather than in the DOM.
 *
 * The corollary matters more: `d` must not be rebuilt when the view changes.
 * Pan and zoom are a transform on a wrapping `<g>`, so the path data is computed
 * when the geometry changes and never again — re-serialising a large `d` on
 * every mouse move is the one reliable way to make SVG feel slow.
 *
 * Which is also why cubics stay cubics. The browser draws a bezier exactly at
 * any zoom; flattening one to line segments here would fix its resolution at
 * whatever zoom happened to be current when it was built.
 * ---------------------------------------------------------------------------
 *
 * Arcs are the exception, and are flattened. They are stored centre-
 * parameterised (see path/arc.js) because the post-processor wants to emit real
 * G2/G3 moves from them, and converting that back to SVG's endpoint form for
 * display would be a second implementation of the same conversion to keep
 * correct. A tenth of the machine's resolution is far finer than a screen.
 */

import { flattenArc } from '@core/path/arc.js';

/**
 * How far a flattened arc may stray from the true one, millimetres.
 *
 * A tenth of what the machine resolves. Fine enough that no zoom this
 * application offers can show the difference, coarse enough that a circle is a
 * few hundred points rather than a few thousand.
 */
export const DISPLAY_TOLERANCE = 0.001;


/**
 * Builds the `d` attribute for one shape.
 *
 * @param {Object[]} subPaths - the shape's subpaths, from `normalizePathData`
 * @param {Object} [options] - options
 * @param {Number} [options.tolerance=DISPLAY_TOLERANCE] - arc flattening tolerance
 * @returns {String} an SVG path data string, empty when there is nothing to draw
 */
export function pathData(subPaths, options = {}) {

	const { tolerance = DISPLAY_TOLERANCE } = options;

	/** @type {String[]} */
	const out = [];

	for (const subPath of subPaths ?? []) {

		if (subPath?.segments === undefined || subPath.segments.length === 0)
			continue;

		out.push(`M${number(subPath.start[0])} ${number(subPath.start[1])}`);

		for (const segment of subPath.segments)
			out.push(command(segment, tolerance));

		if (subPath.closed)
			out.push('Z');
	}

	return out.join('');
}

/**
 * One segment, as path data.
 *
 * @param {Object} segment - the segment
 * @param {Number} tolerance - arc flattening tolerance
 * @returns {String} the command
 */
function command(segment, tolerance) {

	if (segment.type === 'C')
		return `C${number(segment.c1[0])} ${number(segment.c1[1])}`
			+ ` ${number(segment.c2[0])} ${number(segment.c2[1])}`
			+ ` ${number(segment.to[0])} ${number(segment.to[1])}`;

	if (segment.type === 'A')
		return flattenArc(segment.arc, segment.to, tolerance)
			.map((point) => `L${number(point[0])} ${number(point[1])}`)
			.join('');

	return `L${number(segment.to[0])} ${number(segment.to[1])}`;
}

/**
 * Trims a coordinate to something worth putting in an attribute.
 *
 * Four decimals is a ten-thousandth of a millimetre — far past what any screen
 * resolves, and it keeps a large `d` from being a third longer than it needs to
 * be in trailing zeros.
 *
 * @param {Number} value - millimetres
 * @returns {String} the number
 */
function number(value) {
	return Number(value.toFixed(4)).toString();
}


/**
 * Builds the `d` attribute for a run of points.
 *
 * For a TOOLPATH rather than for the drawing. A toolpath is already flat — it
 * came out of Clipper as points — so there is nothing to preserve as a curve and
 * nothing to flatten.
 *
 * @param {Object} run - `{ points, closed }` from `core/cam`
 * @returns {String} an SVG path data string, empty when there is nothing to draw
 */
export function polylineData(run) {

	const points = run?.points ?? [];

	if (points.length === 0)
		return '';

	const out = [`M${number(points[0][0])} ${number(points[0][1])}`];

	for (const point of points.slice(1))
		out.push(`L${number(point[0])} ${number(point[1])}`);

	if (run.closed)
		out.push('Z');

	return out.join('');
}


// Bounds live in core now: four things need them and they are not all UI --
// zoom to fit here, the 2D preview's real-unit sizing, the 3D stock block, and
// telling the user how big an imported drawing came out. Re-exported so this
// module stays the one place the workspace imports geometry helpers from.
export { boundsOfSubPaths as boundsOf, unionBounds, padBounds, sizeOf } from '@core/path/bounds.js';
