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
 * angle. Rigid, shape-preserving, and incapable of folding.
 *
 * **Normal offset** displaces the path along its local normal, so the result
 * follows the shape.
 *
 * ## Why the normal offset goes through Clipper
 *
 * The first implementation built it by hand: arcs on outward bends, mitres on
 * inward ones, then a filter that discarded any point which had folded over
 * (a folded point ends up closer to the source than the offset distance).
 *
 * It passed every test, including a property test asserting that no surviving
 * point was nearer the source than the offset distance — and it was still
 * wrong, because the filter examined POINTS and the tool follows SEGMENTS.
 * On a coarse zigzag (a 25-point skyline, segments 5–27mm long) a mitre at a
 * sharp valley overshot past the far side of a roof. Both of its endpoints sat
 * a legitimate full offset distance away, so the filter kept them, while the
 * segment joining them passed straight through the source line. Measured
 * closest approach: 0.0000mm against a requested 1.5875mm.
 *
 * Clipper's open-path inflate is a true Minkowski offset, so it cannot produce
 * that: measured on the same path it holds 1.5824mm, the 0.005mm shortfall
 * being exactly the arc tolerance, since polygonal arcs are inscribed.
 *
 * So the offset itself is Clipper's. What remains here is extracting one side
 * of the closed outline it returns, which is the part Clipper does not do.
 *
 * There is no "clean" control any more, and there should not be. The correct
 * offset is exact, not a matter of taste — anything short of it is geometry
 * that cuts where it should not.
 */

import { offsetOpen, OpenEnd } from '../geometry/clipper.js';

/** Default arc tolerance for the offset outline, in millimetres. */
export const DEFAULT_TOLERANCE = 0.005;

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
 * Where a point sits relative to one segment: how far, and on which side.
 *
 * @param {Number[]} point - the query point
 * @param {Number[]} a - segment start
 * @param {Number[]} b - segment end
 * @returns {Object} `{ distance, cross }`; cross is positive to the left of a→b
 */
function classifyAgainstSegment(point, a, b) {

	const vx = b[0] - a[0];
	const vy = b[1] - a[1];
	const lengthSquared = (vx * vx) + (vy * vy);

	if (lengthSquared === 0)
		return { distance: Math.hypot(point[0] - a[0], point[1] - a[1]), cross: 0 };

	let t = (((point[0] - a[0]) * vx) + ((point[1] - a[1]) * vy)) / lengthSquared;
	t = Math.max(0, Math.min(1, t));

	const nx = a[0] + (t * vx);
	const ny = a[1] + (t * vy);

	return {
		distance: Math.hypot(point[0] - nx, point[1] - ny),
		cross: (vx * (point[1] - ny)) - (vy * (point[0] - nx)),
	};
}


/**
 * Indexes a path's segments in a uniform grid, for fast nearest-segment queries.
 *
 * Classifying every point of the offset outline against every segment of the
 * source is quadratic. On a 1200-point path that was 400ms for one offset, and
 * this runs while somebody drags a slider — so the grid is not an optimisation
 * so much as the difference between interactive and not.
 *
 * @param {Array<Number[]>} path - the source path
 * @param {Number} cellSize - grid cell size in millimetres
 * @returns {Object} an index exposing `classify(point)`
 */
function buildSegmentIndex(path, cellSize) {

	const cells = new Map();
	const key = (cx, cy) => `${cx},${cy}`;

	for (let i = 0; i + 1 < path.length; i++) {

		const [ax, ay] = path[i];
		const [bx, by] = path[i + 1];

		const minX = Math.floor(Math.min(ax, bx) / cellSize);
		const maxX = Math.floor(Math.max(ax, bx) / cellSize);
		const minY = Math.floor(Math.min(ay, by) / cellSize);
		const maxY = Math.floor(Math.max(ay, by) / cellSize);

		for (let cx = minX; cx <= maxX; cx++) {
			for (let cy = minY; cy <= maxY; cy++) {
				const k = key(cx, cy);
				const bucket = cells.get(k);
				if (bucket === undefined)
					cells.set(k, [i]);
				else
					bucket.push(i);
			}
		}
	}

	return {

		/**
		 * Distance and side for the nearest segment of the source.
		 *
		 * Searches outward one ring of cells at a time, stopping as soon as
		 * nothing further out could beat the best hit so far.
		 *
		 * @param {Number[]} point - the query point
		 * @returns {Object} `{ distance, cross }`
		 */
		classify(point) {

			const cx = Math.floor(point[0] / cellSize);
			const cy = Math.floor(point[1] / cellSize);

			let best = { distance: Infinity, cross: 0 };

			for (let ring = 0; ring < 64; ring++) {

				if (best.distance <= (ring - 1) * cellSize)
					break;

				for (let x = cx - ring; x <= cx + ring; x++) {
					for (let y = cy - ring; y <= cy + ring; y++) {

						// only the newly added outer ring, not the filled square
						if (ring > 0 && Math.abs(x - cx) !== ring && Math.abs(y - cy) !== ring)
							continue;

						const bucket = cells.get(key(x, y));
						if (bucket === undefined)
							continue;

						for (const i of bucket) {
							const found = classifyAgainstSegment(point, path[i], path[i + 1]);
							if (found.distance < best.distance)
								best = found;
						}
					}
				}
			}

			return best;
		},
	};
}


/**
 * Total length of a polyline, in millimetres.
 *
 * @param {Array<Number[]>} path - the polyline
 * @returns {Number} the length
 */
function pathLength(path) {

	let total = 0;

	for (let i = 0; i + 1 < path.length; i++)
		total += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);

	return total;
}


/**
 * Every maximal run of consecutive entries satisfying a predicate.
 *
 * ALL of them, not the longest — that distinction is the whole point.
 *
 * A one-sided offset is only a single continuous path when the source is
 * reasonably well behaved. Give it deep valleys narrower than twice the offset,
 * or a path that deliberately retraces itself, and "the left side" is genuinely
 * several disconnected pieces: the offset region merges across the gap, and what
 * was one side of the line becomes two. The tool would lift and reposition
 * between them, which is a real toolpath, not a defect.
 *
 * An earlier version kept only the longest run. On a skyline with deep valleys
 * that quietly dropped a quarter of the cut, and on a path drawn to retrace
 * itself it dropped most of it.
 *
 * The outline is a closed loop, so a run may wrap past the end of the array;
 * rotating to start at a non-matching entry makes the wrap disappear.
 *
 * @param {Array} items - the loop
 * @param {Function} predicate - called with each item
 * @returns {Array<Array>} every maximal satisfying run, in order
 */
function allRuns(items, predicate) {

	const count = items.length;

	if (count === 0)
		return [];

	const flags = items.map((item) => predicate(item) === true);

	if (flags.every((flag) => flag === true))
		return [[...items]];

	const firstGap = flags.indexOf(false);

	/** @type {Array<Array>} */
	const runs = [];
	let current = [];

	// start just past a gap, so no run straddles the array boundary
	for (let step = 0; step < count; step++) {

		const i = (firstGap + step) % count;

		if (flags[i] === true) {
			current.push(items[i]);
		} else if (current.length > 0) {
			runs.push(current);
			current = [];
		}
	}

	if (current.length > 0)
		runs.push(current);

	return runs;
}


/**
 * Offsets an open path along its normals, to one side.
 *
 * Delegates the offset itself to Clipper — see the file header for why — and
 * then keeps the portion of the resulting closed outline that lies on the
 * requested side of the source.
 *
 * @param {Array<Number[]>} points - the source path, in millimetres
 * @param {Number} distance - offset distance; must be positive
 * @param {Object} [options] - options
 * @param {String} [options.side=Side.LEFT] - which side to offset towards
 * @param {Number} [options.tolerance=DEFAULT_TOLERANCE] - arc tolerance, millimetres
 * @returns {Object} `{ paths, outline }` — the one-sided offset as one or more
 *   polylines, and the full closed outline they were taken from, which is useful
 *   for showing the tool's whole swept area.
 *
 *   `paths` is plural on purpose: see allRuns. A path with deep valleys or one
 *   that retraces itself has a one-sided offset made of several disjoint pieces,
 *   and the tool lifts between them.
 * @throws {RangeError} when the distance is not positive
 */
export function offsetAlongNormals(points, distance, options = {}) {

	const { side = Side.LEFT } = options;
	const both = offsetBothSides(points, distance, options);

	return {
		paths: side === Side.RIGHT ? both.right : both.left,
		outline: both.outline,
	};
}


/**
 * Offsets an open path to BOTH sides at once.
 *
 * Both sides come out of the same closed outline, so asking for them together
 * costs one Clipper call and one spatial index rather than two of each. On a
 * 1200-point path that is the difference between 165ms and 80ms, which matters
 * because this runs behind a slider.
 *
 * @param {Array<Number[]>} points - the source path, in millimetres
 * @param {Number} distance - offset distance; must be positive
 * @param {Object} [options] - options
 * @param {Number} [options.tolerance=DEFAULT_TOLERANCE] - arc tolerance, millimetres
 * @returns {Object} `{ left, right, outline }`, where left and right are ARRAYS
 *   of polylines — see allRuns for why one side can be several pieces
 * @throws {RangeError} when the distance is not positive
 */
export function offsetBothSides(points, distance, options = {}) {

	const { tolerance = DEFAULT_TOLERANCE } = options;

	if (!(distance > 0))
		throw new RangeError(`offsetAlongNormals needs a positive distance, got ${distance}`);

	const source = dedupe(points);

	if (source.length < 2)
		return { left: [], right: [], outline: [] };

	// butt ends, so the offset starts and stops square across the path rather
	// than wrapping round it -- a one-sided offset has nothing to wrap onto
	const outlines = offsetOpen([source], distance, {
		end: OpenEnd.BUTT,
		toleranceMm: tolerance,
	});

	if (outlines.length === 0)
		return { left: [], right: [], outline: [] };

	// the largest outline encloses the path; any others are artefacts
	const outline = outlines.reduce(
		(largest, candidate) => (candidate.length > largest.length ? candidate : largest),
	);

	const index = buildSegmentIndex(source, Math.max(distance, 1e-6));

	// The outline is a closed loop, so it also contains the two end caps, which
	// run square across the path from one side to the other. A cap's points are
	// on both sides and at every distance from zero to the full offset, so a side
	// test alone keeps part of one -- and at a large offset the cap is long,
	// dragging the kept path in towards the source. Requiring the full offset
	// distance as well trims the caps exactly where they leave the offset proper,
	// and states the guarantee we actually want directly.
	const minimumDistance = distance - tolerance - 0.001;

	// EDGES, not vertices. The tool traverses the outline's edges, and a vertex
	// is a worse question to ask than an edge for the same reason the old
	// hand-rolled fold filter was wrong (see the file header): the answer at a
	// point does not describe the move.
	//
	// Concretely: where a spur meets the run it grows from, the outline has a
	// corner sitting exactly equidistant from BOTH source segments. The tie is
	// broken by whichever segment the index happens to reach first, so that one
	// vertex can come back tagged for the far side -- and because a run is a
	// chain, that single wrong tag severs the cut there. On a path drawn to
	// retrace itself this cost three lengths of the top edge, 112mm of 168mm,
	// with no error anywhere: every point was correctly measured, and the wrong
	// thing was measured.
	//
	// An edge's midpoint has no such tie. It sits squarely alongside one source
	// segment, and it is also what excludes the end caps, whose midpoints lie on
	// the source itself at distance zero.
	//
	// The SIDE comes from the midpoint, then, but the CLEARANCE has to come from
	// the whole edge. Where the source curves back on itself near its own end, a
	// butt cap's corner sits nearer the source than the offset distance -- on a
	// 20mm-wavelength wave offset 6mm, 5.953mm against a required 5.994mm. That
	// corner is the first vertex of an otherwise perfectly good run, so judging
	// the edge by its midpoint alone would let the cut start 0.04mm too deep.
	// Taking the worst of the midpoint and both endpoints rejects the offending
	// edge instead, and the run simply starts at the next one.
	//
	// Rejecting rather than trimming also keeps a too-close vertex in the MIDDLE
	// of a run from being quietly dropped, which would leave a chord cutting the
	// corner it was meant to go round. The run breaks in two there, as it should.
	const atVertex = outline.map((point) => index.classify(point));

	const edges = outline.map((a, i) => {

		const j = (i + 1) % outline.length;
		const b = outline[j];
		const at = index.classify([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);

		return {
			a,
			b,
			cross: at.cross,
			clearance: Math.min(at.distance, atVertex[i].distance, atVertex[j].distance),
		};
	});

	// Below one arc chord there is nothing to cut: that is the spacing between
	// consecutive points on the offset's rounded corners, so a shorter run is a
	// fragment of the discretisation rather than a move. Keeping one would put a
	// plunge and a retract into the toolpath for a cut of no length.
	//
	// This is a LENGTH, deliberately, not a point count. A point count looks
	// equivalent and is not: the offset of a straight line is a rectangle, whose
	// left side is one edge between two vertices and a perfectly good 100mm cut.
	const chord = 2 * Math.sqrt(Math.max(0, (2 * distance * tolerance) - (tolerance * tolerance)));
	const minimumRunLength = Math.max(chord, tolerance);

	const keep = (wantLeft) => allRuns(
		edges,
		({ clearance, cross }) =>
			clearance >= minimumDistance && (wantLeft ? cross > 0 : cross < 0),
	)
		// a run of edges is a chain, so its polyline is the first edge's start
		// followed by every edge's end
		.map((run) => [run[0].a, ...run.map(({ b }) => b)])
		.filter((path) => pathLength(path) > minimumRunLength);

	return { left: keep(true), right: keep(false), outline };
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
