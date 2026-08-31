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
 * The rectangle a shape occupies.
 *
 * CONTROL-POINT bounds for cubics: a bezier lies inside the hull of its control
 * points, so this is a true bound but not always a tight one. That is the right
 * trade for what it is used for — zoom to fit, which should leave a little room
 * anyway, and hit-testing a click, which is refined by the browser afterwards.
 * A tight bound means solving for the curve's extrema, which is real work to be
 * slightly wrong about in the other direction.
 *
 * @param {Object[]} subPaths - the shape's subpaths
 * @returns {Object|null} `{ minX, minY, maxX, maxY }`, or null when empty
 */
export function boundsOf(subPaths) {

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	/**
	 * Widens the box to include a point.
	 *
	 * @param {Number[]} point - `[x, y]`
	 */
	const include = (point) => {
		minX = Math.min(minX, point[0]);
		minY = Math.min(minY, point[1]);
		maxX = Math.max(maxX, point[0]);
		maxY = Math.max(maxY, point[1]);
	};

	for (const subPath of subPaths ?? []) {

		if (subPath?.segments === undefined)
			continue;

		include(subPath.start);

		for (const segment of subPath.segments) {

			include(segment.to);

			if (segment.type === 'C') {
				include(segment.c1);
				include(segment.c2);
			}

			// The whole circle the arc is a piece of, which is a bound and a
			// cheap one. `centre` is a POINT, not a pair of cx/cy properties --
			// reading it as the latter gave undefined, then NaN, then a null
			// bounding box and a workspace that would not zoom to anything.
			if (segment.type === 'A') {
				const [cx, cy] = segment.arc.centre;
				const r = Math.max(segment.arc.rx, segment.arc.ry);
				include([cx - r, cy - r]);
				include([cx + r, cy + r]);
			}
		}
	}

	return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}


/**
 * The rectangle several boxes occupy together.
 *
 * @param {Array<Object|null>} boxes - bounds, nulls ignored
 * @returns {Object|null} the union, or null when there is nothing
 */
export function unionBounds(boxes) {

	const real = boxes.filter((box) => box !== null && box !== undefined);

	if (real.length === 0)
		return null;

	return {
		minX: Math.min(...real.map((b) => b.minX)),
		minY: Math.min(...real.map((b) => b.minY)),
		maxX: Math.max(...real.map((b) => b.maxX)),
		maxY: Math.max(...real.map((b) => b.maxY)),
	};
}


/**
 * Grows a box by a margin on every side.
 *
 * @param {Object|null} box - the bounds
 * @param {Number} margin - millimetres
 * @returns {Object|null} the grown box
 */
export function padBounds(box, margin) {

	if (box === null || box === undefined)
		return null;

	return {
		minX: box.minX - margin,
		minY: box.minY - margin,
		maxX: box.maxX + margin,
		maxY: box.maxY + margin,
	};
}
