/**
 * @file openOffset.js
 * @description Offsetting for OPEN paths — the operations a line has instead of
 * "inside" and "outside".
 *
 * An open path has no interior, so the closed-path operations are meaningless
 * for it. jscut's answer is to force it closed, which turns "follow this line"
 * into "cut out this zero-area sliver". Two operations replace them:
 *
 * **Heading offset** displaces the whole path a fixed distance along a fixed
 * angle. Rigid, trivially predictable, and what you want when you are shifting a
 * cut sideways to account for something physical.
 *
 * **Path-normal offset** displaces every point along the local normal, so the
 * result follows the shape. This is the interesting one, and the messy one: on
 * the inside of a bend the offset folds over itself, and on the outside it
 * spreads apart. Both have to be dealt with.
 *
 * ## How the mess is handled
 *
 * Outward bends get an **arc**, exactly as a round join does on a closed offset,
 * with its angular step derived from the sagitta so the deviation is bounded
 * rather than guessed. Without this, a corner is chorded across and the offset
 * comes out short precisely where it should be furthest out.
 *
 * Inward bends get a **mitre**, which on a tight bend deliberately overshoots
 * and crosses the neighbouring geometry. Those crossings are then removed by a
 * single observation: a point that folded over ends up CLOSER to the source path
 * than the offset distance. Filtering on that removes every self-intersection
 * loop without needing to find the intersections at all, and the threshold is
 * exactly what the "clean" control adjusts.
 */

import { arcAngularStep } from '../path/arc.js';

/** Default fraction of the offset distance a point must keep from the source. */
export const DEFAULT_CLEAN = 0.9;

/** Default arc tolerance for outward bends, in millimetres. */
export const DEFAULT_TOLERANCE = 0.01;

/** How far a mitre may reach, as a multiple of the offset distance. */
const MITRE_LIMIT = 10;

/** Which side of the path to offset towards. */
export const Side = Object.freeze({ LEFT: 'left', RIGHT: 'right' });


/**
 * Offsets a path a fixed distance along a fixed heading.
 *
 * Every point moves by the same vector, so the shape is preserved exactly and
 * nothing can fold or self-intersect.
 *
 * @param {Array<Number[]>} points - the path
 * @param {Number} distance - how far to move, millimetres
 * @param {Number} angleRadians - heading, counter-clockwise from +X
 * @returns {Array<Number[]>} the displaced path
 */
export function offsetByHeading(points, distance, angleRadians) {

	const dx = Math.cos(angleRadians) * distance;
	const dy = Math.sin(angleRadians) * distance;

	return points.map(([x, y]) => [x + dx, y + dy]);
}


/**
 * Removes consecutive duplicate points, which have no direction.
 *
 * @param {Array<Number[]>} points - the path
 * @param {Number} epsilon - distance below which two points are the same
 * @returns {Array<Number[]>} the cleaned path
 */
function dedupe(points, epsilon = 1e-9) {

	const out = [];

	for (const point of points) {
		const last = out[out.length - 1];
		if (last === undefined || Math.hypot(point[0] - last[0], point[1] - last[1]) > epsilon)
			out.push(point);
	}

	return out;
}


/**
 * Unit left-hand normals for each segment of a path.
 *
 * In our y-up space the left normal of a direction (dx, dy) is (-dy, dx).
 *
 * @param {Array<Number[]>} points - the path
 * @returns {Array<Number[]>} one normal per segment, so one fewer than points
 */
function segmentNormals(points) {

	const normals = [];

	for (let i = 0; i + 1 < points.length; i++) {

		const dx = points[i + 1][0] - points[i][0];
		const dy = points[i + 1][1] - points[i][1];
		const length = Math.hypot(dx, dy);

		normals.push(length === 0 ? [0, 0] : [-dy / length, dx / length]);
	}

	return normals;
}


/**
 * Intersects two lines given as a point and a direction each.
 *
 * @param {Number[]} p - a point on the first line
 * @param {Number[]} r - direction of the first line
 * @param {Number[]} q - a point on the second line
 * @param {Number[]} s - direction of the second line
 * @returns {Number[]|null} the intersection, or null if effectively parallel
 */
function intersectLines(p, r, q, s) {

	const denominator = (r[0] * s[1]) - (r[1] * s[0]);

	if (Math.abs(denominator) < 1e-12)
		return null;

	const t = (((q[0] - p[0]) * s[1]) - ((q[1] - p[1]) * s[0])) / denominator;

	return [p[0] + (t * r[0]), p[1] + (t * r[1])];
}


/**
 * Shortest distance from a point to a line segment.
 *
 * @param {Number[]} point - the point
 * @param {Number[]} a - segment start
 * @param {Number[]} b - segment end
 * @returns {Number} the distance
 */
function distanceToSegment(point, a, b) {

	const vx = b[0] - a[0];
	const vy = b[1] - a[1];
	const lengthSquared = (vx * vx) + (vy * vy);

	if (lengthSquared === 0)
		return Math.hypot(point[0] - a[0], point[1] - a[1]);

	let t = (((point[0] - a[0]) * vx) + ((point[1] - a[1]) * vy)) / lengthSquared;
	t = Math.max(0, Math.min(1, t));

	return Math.hypot(point[0] - (a[0] + (t * vx)), point[1] - (a[1] + (t * vy)));
}


/**
 * Builds a uniform grid over a path's segments, for fast distance queries.
 *
 * The fold filter asks "how far is this point from the source path" once per
 * offset point, which is quadratic if answered by scanning every segment. A path
 * of a few thousand points makes that millions of comparisons per redraw, and
 * this runs while somebody drags a slider.
 *
 * @param {Array<Number[]>} points - the source path
 * @param {Number} cellSize - grid cell size in millimetres
 * @returns {Object} an index exposing `distanceTo(point)`
 */
function buildSegmentIndex(points, cellSize) {

	const cells = new Map();
	const key = (cx, cy) => `${cx},${cy}`;

	const add = (cx, cy, index) => {
		const k = key(cx, cy);
		const bucket = cells.get(k);
		if (bucket === undefined)
			cells.set(k, [index]);
		else
			bucket.push(index);
	};

	for (let i = 0; i + 1 < points.length; i++) {

		const [ax, ay] = points[i];
		const [bx, by] = points[i + 1];

		// register the segment in every cell its bounding box touches
		const minX = Math.floor(Math.min(ax, bx) / cellSize);
		const maxX = Math.floor(Math.max(ax, bx) / cellSize);
		const minY = Math.floor(Math.min(ay, by) / cellSize);
		const maxY = Math.floor(Math.max(ay, by) / cellSize);

		for (let cx = minX; cx <= maxX; cx++)
			for (let cy = minY; cy <= maxY; cy++)
				add(cx, cy, i);
	}

	return {

		/**
		 * Distance from a point to the nearest segment of the source path.
		 *
		 * Searches outward one ring of cells at a time and stops as soon as the
		 * nearest hit so far cannot be beaten by anything further out.
		 *
		 * @param {Number[]} point - the query point
		 * @returns {Number} the distance
		 */
		distanceTo(point) {

			const cx = Math.floor(point[0] / cellSize);
			const cy = Math.floor(point[1] / cellSize);

			let best = Infinity;

			for (let ring = 0; ring < 64; ring++) {

				// anything beyond this ring is at least this far away
				if (best <= (ring - 1) * cellSize)
					break;

				for (let x = cx - ring; x <= cx + ring; x++) {
					for (let y = cy - ring; y <= cy + ring; y++) {

						// only the newly added outer ring, not the filled square
						if (ring > 0 && Math.abs(x - cx) !== ring && Math.abs(y - cy) !== ring)
							continue;

						const bucket = cells.get(key(x, y));
						if (bucket === undefined)
							continue;

						for (const i of bucket)
							best = Math.min(best, distanceToSegment(point, points[i], points[i + 1]));
					}
				}
			}

			return best;
		},
	};
}


/**
 * Offsets an open path along its own normals.
 *
 * @param {Array<Number[]>} points - the source path, in millimetres
 * @param {Number} distance - offset distance; must be positive
 * @param {Object} [options] - options
 * @param {String} [options.side=Side.LEFT] - which side to offset towards
 * @param {Number} [options.clean=DEFAULT_CLEAN] - 0 leaves every self-intersection
 *   in place; 1 removes any point that came closer to the source than the full
 *   offset distance. Values in between trade tidiness for fidelity.
 * @param {Number} [options.tolerance=DEFAULT_TOLERANCE] - arc tolerance on outward bends
 * @returns {Object} `{ points, removed, raw }` — the cleaned path, how many points
 *   the fold filter discarded, and the uncleaned path for comparison
 * @throws {RangeError} when the distance is not positive
 */
export function offsetAlongNormals(points, distance, options = {}) {

	const {
		side = Side.LEFT,
		clean = DEFAULT_CLEAN,
		tolerance = DEFAULT_TOLERANCE,
	} = options;

	if (!(distance > 0))
		throw new RangeError(`offsetAlongNormals needs a positive distance, got ${distance}`);

	const source = dedupe(points);

	if (source.length < 2)
		return { points: [], removed: 0, raw: [] };

	// offsetting to the right is the same operation mirrored
	const signed = side === Side.RIGHT ? -distance : distance;

	const normals = segmentNormals(source);
	const step = arcAngularStep({ rx: distance, ry: distance }, tolerance);

	/** @type {Array<Number[]>} */
	const raw = [];

	// first point: straight out along the first segment's normal
	raw.push([
		source[0][0] + (signed * normals[0][0]),
		source[0][1] + (signed * normals[0][1]),
	]);

	for (let i = 1; i + 1 < source.length; i++) {

		const previous = normals[i - 1];
		const next = normals[i];

		// which way the path turns here, and therefore whether the offset side is
		// on the outside of the bend (spreads, wants an arc) or the inside (folds)
		const cross = (source[i][0] - source[i - 1][0]) * (source[i + 1][1] - source[i][1])
			- ((source[i][1] - source[i - 1][1]) * (source[i + 1][0] - source[i][0]));

		const turningTowardOffset = signed > 0 ? cross > 0 : cross < 0;

		if (turningTowardOffset === false && Math.abs(cross) > 1e-12) {

			// outward bend: sweep an arc so the offset stays a full distance out
			const startAngle = Math.atan2(previous[1], previous[0]);
			let sweep = Math.atan2(next[1], next[0]) - startAngle;

			while (sweep > Math.PI) sweep -= Math.PI * 2;
			while (sweep < -Math.PI) sweep += Math.PI * 2;

			const count = Math.max(1, Math.ceil(Math.abs(sweep) / step));

			for (let k = 0; k <= count; k++) {
				const angle = startAngle + (sweep * (k / count));
				raw.push([
					source[i][0] + (signed * Math.cos(angle)),
					source[i][1] + (signed * Math.sin(angle)),
				]);
			}

		} else {

			// inward bend: mitre to the intersection of the two offset lines, and
			// let the fold filter clear up whatever crosses
			const a = [source[i - 1][0] + (signed * previous[0]), source[i - 1][1] + (signed * previous[1])];
			const b = [source[i][0] + (signed * next[0]), source[i][1] + (signed * next[1])];

			const dirA = [source[i][0] - source[i - 1][0], source[i][1] - source[i - 1][1]];
			const dirB = [source[i + 1][0] - source[i][0], source[i + 1][1] - source[i][1]];

			const hit = intersectLines(a, dirA, b, dirB);

			const reach = hit === null
				? Infinity
				: Math.hypot(hit[0] - source[i][0], hit[1] - source[i][1]);

			if (hit !== null && reach <= Math.abs(distance) * MITRE_LIMIT) {
				raw.push(hit);
			} else {
				// a near-reversal sends the mitre to infinity; fall back to the
				// averaged normal, which the filter will usually discard anyway
				const mx = (previous[0] + next[0]) / 2;
				const my = (previous[1] + next[1]) / 2;
				const length = Math.hypot(mx, my) || 1;
				raw.push([
					source[i][0] + (signed * mx / length),
					source[i][1] + (signed * my / length),
				]);
			}
		}
	}

	// last point: straight out along the final segment's normal
	const last = source.length - 1;
	raw.push([
		source[last][0] + (signed * normals[normals.length - 1][0]),
		source[last][1] + (signed * normals[normals.length - 1][1]),
	]);

	if (clean <= 0)
		return { points: raw, removed: 0, raw };

	// A point that folded over sits closer to the source than the offset
	// distance. That single fact removes every self-intersection loop without
	// having to locate a single intersection.
	const threshold = distance * Math.min(clean, 1);
	const index = buildSegmentIndex(source, Math.max(distance, 1e-6));

	const kept = raw.filter((point) => index.distanceTo(point) >= threshold - 1e-9);

	return { points: kept, removed: raw.length - kept.length, raw };
}


/**
 * Resamples a path to an even spacing along its length.
 *
 * Offsetting leaves points bunched on inward bends and spread on outward ones.
 * Even spacing keeps the feed steady and stops a long chord from cutting a
 * corner it should have gone round.
 *
 * @param {Array<Number[]>} points - the path
 * @param {Number} spacing - target distance between points, millimetres
 * @returns {Array<Number[]>} the resampled path, keeping both endpoints
 * @throws {RangeError} when the spacing is not positive
 */
export function resample(points, spacing) {

	if (!(spacing > 0))
		throw new RangeError(`resample needs a positive spacing, got ${spacing}`);

	if (points.length < 2)
		return [...points];

	const out = [points[0]];
	let carry = 0;

	for (let i = 0; i + 1 < points.length; i++) {

		const [ax, ay] = points[i];
		const [bx, by] = points[i + 1];
		const length = Math.hypot(bx - ax, by - ay);

		if (length === 0)
			continue;

		let travelled = spacing - carry;

		while (travelled < length) {
			const t = travelled / length;
			out.push([ax + (t * (bx - ax)), ay + (t * (by - ay))]);
			travelled += spacing;
		}

		carry = length - (travelled - spacing);
	}

	out.push(points[points.length - 1]);

	return out;
}
