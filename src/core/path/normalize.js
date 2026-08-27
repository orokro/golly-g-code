/**
 * @file normalize.js
 * @description Reduces arbitrary SVG path data to one canonical form.
 *
 * Everything downstream — offsetting, flattening, tabs, G-code — works on the
 * output of this module, so this is where the pipeline's variety collapses. A
 * path arrives with any mix of relative/absolute coordinates, shorthand curves,
 * horizontal/vertical lines, elliptical arcs and multiple subpaths; it leaves as
 * subpaths made only of straight lines and cubic beziers, in absolute
 * coordinates, each flagged open or closed.
 *
 * Two decisions here are worth understanding:
 *
 * **Lines are not promoted to curves.** It would be less code to make everything
 * a cubic, but a line needs no subdivision when flattening and is exactly
 * representable when we later fit arcs for G2/G3 output. Throwing that away on
 * the first pass and trying to recover it at the end would be silly.
 *
 * **Open and closed are tracked honestly.** jscut treats every contour as a
 * closed polygon, which is what turns "follow this line" into "cut out this
 * zero-area sliver". A subpath is closed here only if it says so with a `Z`, or
 * if its endpoints genuinely coincide — and we record which of the two it was,
 * because "the artist closed this" and "this happens to end where it started"
 * are different facts.
 */

import svgpath from 'svgpath';
import { endpointToCentre } from './arc.js';

/**
 * The SVG transform-list grammar, loosely enforced.
 *
 * svgpath silently ignores a transform it cannot parse, which would place
 * geometry somewhere other than where the artwork says without a word of
 * complaint. Since that failure mode ends in a ruined workpiece, we check the
 * shape of the string ourselves and refuse rather than guess.
 */
const TRANSFORM_GRAMMAR =
	/^\s*(?:(?:matrix|translate|scale|rotate|skewX|skewY)\s*\(\s*[-+0-9eE.\s,]+\)\s*,?\s*)+$/;

/**
 * Default tolerance for deciding that a subpath's endpoints coincide.
 *
 * In SVG user units at this stage, not millimetres — the document scale has not
 * been applied yet. Deliberately tight: this is for detecting an exact join that
 * lost its `Z`, not for stitching together things the artist left apart.
 */
export const DEFAULT_COINCIDENCE_TOLERANCE = 1e-9;

/** Two thirds, used by the exact quadratic-to-cubic elevation. */
const TWO_THIRDS = 2 / 3;


/**
 * @typedef {Object} Segment
 * @property {'L'|'C'|'A'} type - straight line, cubic bezier, or elliptical arc
 * @property {Number[]} to - endpoint as [x, y]
 * @property {Number[]} [c1] - first control point, cubics only
 * @property {Number[]} [c2] - second control point, cubics only
 * @property {Object} [arc] - centre-parameterized arc, arcs only. Kept rather
 *   than converted to cubics so that flattening can hit an exact tolerance and
 *   the post-processor can emit a real G2/G3 move. See arc.js.
 */

/**
 * @typedef {Object} SubPath
 * @property {Number[]} start - the subpath's first point as [x, y]
 * @property {Segment[]} segments - segments in order; never empty
 * @property {Boolean} closed - whether this subpath forms a closed loop
 * @property {String|null} closedBy - 'z' if explicitly closed, 'coincident' if
 *   inferred from its endpoints, null if open
 */

/**
 * @typedef {Object} NormalizeResult
 * @property {SubPath[]} subPaths - the normalized subpaths
 * @property {String[]} warnings - human-readable notes about anything dropped
 */


/**
 * Elevates a quadratic bezier to an exactly equivalent cubic.
 *
 * This is not an approximation: every quadratic has a unique cubic
 * representation, obtained by pulling each control point two thirds of the way
 * from its endpoint toward the quadratic's single control point.
 *
 * @param {Number[]} from - start point [x, y]
 * @param {Number[]} control - the quadratic's control point [x, y]
 * @param {Number[]} to - end point [x, y]
 * @returns {Segment} the equivalent cubic segment
 */
export function quadraticToCubic(from, control, to) {

	return {
		type: 'C',
		c1: [
			from[0] + TWO_THIRDS * (control[0] - from[0]),
			from[1] + TWO_THIRDS * (control[1] - from[1]),
		],
		c2: [
			to[0] + TWO_THIRDS * (control[0] - to[0]),
			to[1] + TWO_THIRDS * (control[1] - to[1]),
		],
		to: [to[0], to[1]],
	};
}


/**
 * Squared distance between two points.
 *
 * Squared, to avoid a pointless square root in comparisons.
 *
 * @param {Number[]} a - first point [x, y]
 * @param {Number[]} b - second point [x, y]
 * @returns {Number} the squared distance
 */
function distanceSquared(a, b) {

	const dx = a[0] - b[0];
	const dy = a[1] - b[1];
	return (dx * dx) + (dy * dy);
}


/**
 * Normalizes SVG path data into canonical subpaths.
 *
 * @param {String} d - raw SVG path data
 * @param {Object} [options] - options
 * @param {String} [options.transform] - an SVG transform attribute to apply first.
 *   Applied before arcs are converted, so a non-uniform scale correctly
 *   re-parameterizes the ellipse rather than distorting an approximation of it.
 * @param {Number} [options.coincidenceTolerance] - distance below which a
 *   subpath's endpoints count as the same point
 * @returns {NormalizeResult} the subpaths, plus notes on anything dropped
 * @throws {Error} when the path data cannot be parsed
 */
export function normalizePathData(d, options = {}) {

	const {
		transform = null,
		coincidenceTolerance = DEFAULT_COINCIDENCE_TOLERANCE,
	} = options;

	/** @type {String[]} */
	const warnings = [];

	if (typeof d !== 'string' || d.trim() === '')
		return { subPaths: [], warnings: ['Empty path data'] };

	let parsed = svgpath(d);

	if (parsed.err)
		throw new Error(`Could not parse path data: ${parsed.err}`);

	if (transform !== null && String(transform).trim() !== '') {

		if (TRANSFORM_GRAMMAR.test(String(transform)) === false)
			throw new Error(`Could not parse transform "${transform}"`);

		parsed = parsed.transform(transform);

		if (parsed.err)
			throw new Error(`Could not apply transform "${transform}": ${parsed.err}`);
	}

	// abs() makes every coordinate absolute and unshort() expands S and T into
	// their long forms. Note we deliberately do NOT call unarc(): arcs are kept as
	// arcs, because approximating them with cubics here costs accuracy that the
	// flattener cannot see or recover. See the header of arc.js.
	parsed = parsed.abs().unshort();

	if (parsed.err)
		throw new Error(`Could not normalize path data: ${parsed.err}`);

	/** @type {SubPath[]} */
	const subPaths = [];

	/** @type {SubPath|null} */
	let current = null;

	/**
	 * Finishes the in-progress subpath and files it, if it has any geometry.
	 *
	 * @param {String|null} closedBy - 'z' when an explicit Z ended it
	 * @returns {void}
	 */
	const flushSubPath = (closedBy) => {

		if (current === null)
			return;

		if (current.segments.length === 0) {
			// a lone moveto with nothing after it draws nothing at all
			warnings.push(`Dropped an empty subpath at ${current.start[0]},${current.start[1]}`);
			current = null;
			return;
		}

		if (closedBy === 'z') {
			current.closed = true;
			current.closedBy = 'z';

		} else {
			// no Z, but the pen may still have returned exactly to its origin
			const last = current.segments[current.segments.length - 1].to;
			const coincident = distanceSquared(current.start, last)
				<= (coincidenceTolerance * coincidenceTolerance);

			current.closed = coincident;
			current.closedBy = coincident ? 'coincident' : null;
		}

		subPaths.push(current);
		current = null;
	};

	parsed.iterate((seg, index, x, y) => {

		const command = seg[0];

		switch (command) {

			case 'M': {
				flushSubPath(null);
				current = { start: [seg[1], seg[2]], segments: [], closed: false, closedBy: null };
				break;
			}

			case 'L':
			case 'H':
			case 'V': {
				// H and V carry a single coordinate; the other axis is inherited
				const to = command === 'L' ? [seg[1], seg[2]]
					: command === 'H' ? [seg[1], y]
						: [x, seg[1]];

				if (current === null) {
					// a drawing command with no preceding moveto: start at the pen
					current = { start: [x, y], segments: [], closed: false, closedBy: null };
				}

				// a zero-length segment contributes nothing but breaks angle maths later
				if (to[0] !== x || to[1] !== y)
					current.segments.push({ type: 'L', to });

				break;
			}

			case 'C': {
				if (current === null) {
					current = { start: [x, y], segments: [], closed: false, closedBy: null };
				}

				current.segments.push({
					type: 'C',
					c1: [seg[1], seg[2]],
					c2: [seg[3], seg[4]],
					to: [seg[5], seg[6]],
				});
				break;
			}

			case 'Q': {
				if (current === null) {
					current = { start: [x, y], segments: [], closed: false, closedBy: null };
				}

				current.segments.push(quadraticToCubic([x, y], [seg[1], seg[2]], [seg[3], seg[4]]));
				break;
			}

			case 'A': {
				if (current === null) {
					current = { start: [x, y], segments: [], closed: false, closedBy: null };
				}

				const to = [seg[6], seg[7]];
				const arc = endpointToCentre(
					[x, y],
					seg[1], seg[2], seg[3],
					seg[4] !== 0, seg[5] !== 0,
					to,
				);

				// a zero radius or coincident endpoints degrade to a straight line,
				// which is what the spec asks for rather than an error
				if (arc === null) {
					if (to[0] !== x || to[1] !== y)
						current.segments.push({ type: 'L', to });
				} else {
					current.segments.push({ type: 'A', arc, to });
				}

				break;
			}

			case 'Z': {
				if (current !== null) {

					// close the loop geometrically if the pen is not already home,
					// so the closing edge exists as a real segment for offsetting
					const last = current.segments.length > 0
						? current.segments[current.segments.length - 1].to
						: current.start;

					if (distanceSquared(last, current.start) > 0)
						current.segments.push({ type: 'L', to: [current.start[0], current.start[1]] });
				}

				flushSubPath('z');

				// per spec the pen stays at the subpath's origin, and a drawing
				// command following Z begins a new subpath from that same point
				current = null;
				break;
			}

			default:
				warnings.push(`Ignored unexpected path command "${command}" at segment ${index}`);
				break;
		}
	});

	flushSubPath(null);

	return { subPaths, warnings };
}


/**
 * Counts how many subpaths in a result are open.
 *
 * Convenience for the UI, which needs to offer a different operation set for
 * open paths (offset / path-normal) than for closed ones (inside / outside).
 *
 * @param {SubPath[]} subPaths - normalized subpaths
 * @returns {Number} the number of open subpaths
 */
export function countOpenSubPaths(subPaths) {

	return subPaths.filter((subPath) => subPath.closed === false).length;
}
