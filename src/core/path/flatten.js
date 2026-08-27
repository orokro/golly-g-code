/**
 * @file flatten.js
 * @description Converts cubic beziers into polylines within a guaranteed
 * distance tolerance.
 *
 * This is where jscut goes wrong in a way that is easy to miss. Its
 * `linearizeCubicBezier` doubles the segment count until every **chord** is
 * shorter than a given length — so the parameter controls segment *size*, not
 * accuracy. A gentle 200mm arc and a tight 2mm arc get wildly different fidelity
 * from the same setting, and there is no way to say "stay within 0.01mm of the
 * true curve", which is the only thing a machinist actually cares about.
 *
 * Here the tolerance is a real deviation bound, in the same units as the input.
 * Subdivision is adaptive: flat stretches cost few points, tight corners get as
 * many as they need, and the result is guaranteed never to stray further from
 * the true curve than the tolerance allows.
 *
 * The bound used is conservative rather than exact. Writing a cubic's departure
 * from its chord as
 *
 *     3(1-t)^2 t (c1 - L1)  +  3(1-t) t^2 (c2 - L2)
 *
 * where L1 and L2 are where the control points would sit if the curve were
 * straight, and noting that each weight peaks at 4/9, gives
 *
 *     error <= (4/9) * (|c1 - L1| + |c2 - L2|)
 *
 * Erring toward more points than strictly necessary is the right direction to be
 * wrong in when the output drives a cutting tool.
 */

import { flattenArc } from './arc.js';

/**
 * Default deviation tolerance, in the units of the incoming geometry.
 *
 * 0.01mm sits comfortably below what a hobby router resolves (~0.05mm at best),
 * so flattening is not the limiting factor on accuracy.
 */
export const DEFAULT_FLATTEN_TOLERANCE = 0.01;

/**
 * Hard cap on recursive subdivision.
 *
 * Each level halves the error, so 24 levels is an absurd amount of headroom.
 * It exists so that degenerate input (NaN, coincident control points arranged
 * pathologically) cannot spin forever.
 */
const MAX_SUBDIVISION_DEPTH = 24;

/** The peak value of both bernstein weights in the error expression. */
const WEIGHT_PEAK = 4 / 9;


/**
 * Distance between two points.
 *
 * @param {Number} ax - first x
 * @param {Number} ay - first y
 * @param {Number} bx - second x
 * @param {Number} by - second y
 * @returns {Number} the euclidean distance
 */
function distance(ax, ay, bx, by) {

	const dx = ax - bx;
	const dy = ay - by;
	return Math.sqrt((dx * dx) + (dy * dy));
}


/**
 * Upper bound on how far a cubic departs from the straight chord between its
 * endpoints.
 *
 * See the file header for the derivation.
 *
 * @param {Number[]} p0 - start point [x, y]
 * @param {Number[]} c1 - first control point [x, y]
 * @param {Number[]} c2 - second control point [x, y]
 * @param {Number[]} p3 - end point [x, y]
 * @returns {Number} an upper bound on the maximum deviation
 */
export function cubicFlatnessBound(p0, c1, c2, p3) {

	// where the control points would sit if this curve were a straight line
	const l1x = p0[0] + ((p3[0] - p0[0]) / 3);
	const l1y = p0[1] + ((p3[1] - p0[1]) / 3);
	const l2x = p0[0] + (2 * (p3[0] - p0[0]) / 3);
	const l2y = p0[1] + (2 * (p3[1] - p0[1]) / 3);

	const d1 = distance(c1[0], c1[1], l1x, l1y);
	const d2 = distance(c2[0], c2[1], l2x, l2y);

	return WEIGHT_PEAK * (d1 + d2);
}


/**
 * Recursively subdivides a cubic until it is flat enough, appending points.
 *
 * Appends only endpoints — the caller is responsible for having already placed
 * the curve's start point.
 *
 * @param {Number[]} p0 - start point [x, y]
 * @param {Number[]} c1 - first control point [x, y]
 * @param {Number[]} c2 - second control point [x, y]
 * @param {Number[]} p3 - end point [x, y]
 * @param {Number} tolerance - maximum permitted deviation
 * @param {Array<Number[]>} out - array to append points to
 * @param {Number} depth - current recursion depth
 * @returns {void}
 */
function subdivideCubic(p0, c1, c2, p3, tolerance, out, depth) {

	if (depth >= MAX_SUBDIVISION_DEPTH || cubicFlatnessBound(p0, c1, c2, p3) <= tolerance) {
		out.push([p3[0], p3[1]]);
		return;
	}

	// de Casteljau split at t = 0.5
	const m01 = [(p0[0] + c1[0]) / 2, (p0[1] + c1[1]) / 2];
	const m12 = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
	const m23 = [(c2[0] + p3[0]) / 2, (c2[1] + p3[1]) / 2];

	const m012 = [(m01[0] + m12[0]) / 2, (m01[1] + m12[1]) / 2];
	const m123 = [(m12[0] + m23[0]) / 2, (m12[1] + m23[1]) / 2];

	const mid = [(m012[0] + m123[0]) / 2, (m012[1] + m123[1]) / 2];

	subdivideCubic(p0, m01, m012, mid, tolerance, out, depth + 1);
	subdivideCubic(mid, m123, m23, p3, tolerance, out, depth + 1);
}


/**
 * Evaluates a cubic bezier at a parameter value.
 *
 * Used by tests to measure real deviation, and by anything that needs a point
 * partway along a curve.
 *
 * @param {Number[]} p0 - start point [x, y]
 * @param {Number[]} c1 - first control point [x, y]
 * @param {Number[]} c2 - second control point [x, y]
 * @param {Number[]} p3 - end point [x, y]
 * @param {Number} t - parameter in [0, 1]
 * @returns {Number[]} the point on the curve as [x, y]
 */
export function evaluateCubic(p0, c1, c2, p3, t) {

	const u = 1 - t;
	const a = u * u * u;
	const b = 3 * u * u * t;
	const c = 3 * u * t * t;
	const d = t * t * t;

	return [
		(a * p0[0]) + (b * c1[0]) + (c * c2[0]) + (d * p3[0]),
		(a * p0[1]) + (b * c1[1]) + (c * c2[1]) + (d * p3[1]),
	];
}


/**
 * Flattens one normalized subpath into a polyline.
 *
 * The returned points carry **no duplicate closing point** for a closed
 * subpath — the `closed` flag says it, and repeating the first point is the
 * convention Clipper and most geometry code expect to be absent.
 *
 * @param {Object} subPath - a subpath from `normalizePathData`
 * @param {Object} [options] - options
 * @param {Number} [options.tolerance] - maximum deviation from the true curve
 * @returns {Object} `{ points: Array<Number[]>, closed: Boolean }`
 */
export function flattenSubPath(subPath, options = {}) {

	const { tolerance = DEFAULT_FLATTEN_TOLERANCE } = options;

	if (!(tolerance > 0))
		throw new RangeError(`Flatten tolerance must be positive, got ${tolerance}`);

	/** @type {Array<Number[]>} */
	const points = [[subPath.start[0], subPath.start[1]]];

	let cursor = subPath.start;

	for (const segment of subPath.segments) {

		if (segment.type === 'L') {
			points.push([segment.to[0], segment.to[1]]);

		} else if (segment.type === 'A') {
			// arcs flatten analytically -- the sagitta of a circular segment has a
			// closed form, so the error bound here is exact rather than estimated
			for (const point of flattenArc(segment.arc, segment.to, tolerance))
				points.push(point);

		} else {
			subdivideCubic(cursor, segment.c1, segment.c2, segment.to, tolerance, points, 0);
		}

		cursor = segment.to;
	}

	// a closed loop ends where it began; drop the repeat so the polygon is stated
	// once, by its points, and once only
	if (subPath.closed === true && points.length > 1) {

		const first = points[0];
		const last = points[points.length - 1];

		if (first[0] === last[0] && first[1] === last[1])
			points.pop();
	}

	return { points, closed: subPath.closed === true };
}


/**
 * Flattens every subpath in a normalized result.
 *
 * @param {Array<Object>} subPaths - subpaths from `normalizePathData`
 * @param {Object} [options] - options, forwarded to `flattenSubPath`
 * @returns {Array<Object>} one `{ points, closed }` per subpath
 */
export function flattenSubPaths(subPaths, options = {}) {

	return subPaths.map((subPath) => flattenSubPath(subPath, options));
}
