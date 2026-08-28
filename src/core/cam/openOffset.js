/**
 * @file openOffset.js
 * @description Offsetting for OPEN paths — the operations a line has instead of
 * "inside" and "outside".
 *
 * An open path has no interior, so "inside", "outside" and "centre" — which are
 * defined relative to an enclosed area — are meaningless for it. jscut's answer
 * is to force the path closed, which turns "follow this line" into "cut out this
 * zero-area sliver". Three operations replace them, and `openToolpath` is the
 * one entry point that gives you any of them:
 *
 * **Centre** puts the tool centre on the line. The cut straddles it, half a
 * diameter each side. The only mode that follows the drawing verbatim.
 *
 * **Heading offset** displaces the whole path a fixed distance along a fixed
 * angle. Rigid, shape-preserving, and incapable of folding.
 *
 * **Normal offset** displaces the path along its local normal, so the result
 * follows the shape. One continuous cut, start to finish. The drawn line becomes
 * one EDGE of the cut rather than its middle.
 *
 * ## Why the offset goes through Clipper
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
 * that. What remains here is taking one side of the closed outline it returns,
 * which is the part Clipper does not do.
 *
 * ## Why one side is ONE path, and how the second version got that wrong
 *
 * The outline is a closed loop with an obvious structure: cap, one side, cap,
 * the other side, back to the start. So "the left side" is simply **the stretch
 * of that loop between the two ends of the path**. Walk it and you are done.
 * One continuous cut, which is what a person drawing a line expects: start at
 * one end, finish at the other.
 *
 * The version before this one did not see that. It asked, of every point on the
 * outline, "are you on the left of the nearest source segment?" and kept the
 * runs that said yes. That question has no good answer in two places, and both
 * of them are ordinary things to draw:
 *
 *   - **At a reversal**, where the path doubles back, left and right SWAP in
 *     space. The tool should simply wrap the tip and carry on, and the honest
 *     answer to "which side is this?" is "both". The side test cut the path in
 *     two there.
 *   - **Where the offset merges with itself** — a valley narrower than twice
 *     the offset — the outline runs over the top of the valley, belonging to
 *     neither side in particular. The side test dropped it.
 *
 * On Greg's 25-point skyline that produced NINE pieces where there should have
 * been one, three of them sub-millimetre slivers sitting across the line from
 * the rest, and it made a linking-and-ordering problem out of nothing. His
 * reaction to the picture — "the skyline is one continuous line, why can't it
 * start on the left side, go to the right in one cut?" — is the whole answer.
 * It can. It always could.
 *
 * ## Why ROUND ends
 *
 * With butt ends the outline contains two straight edges lying ACROSS the path,
 * running from full offset on one side, through the path itself, to full offset
 * on the other. Every point on such an edge is nearer the source than the offset
 * distance, so the guarantee this module exists to provide depends on the walk
 * carefully excluding them — and where the offset merges near an end, the cap
 * stops being one identifiable edge and the exclusion quietly fails. Measured on
 * a 20mm-wavelength wave offset 6mm: 4.4087mm against a required 5.994mm.
 *
 * With round ends there is no such edge. Every point of the outline is exactly
 * the offset distance from the source, so **any** arc of it is safe by
 * construction. Getting the split wrong can then cost coverage, but it cannot
 * cut into the work. That is worth more than the tidier corner butt ends give,
 * and the walk trims the round part off anyway by starting square.
 */

import { offsetOpen, OpenEnd } from '../geometry/clipper.js';

/** Default arc tolerance for the offset outline, in millimetres. */
export const DEFAULT_TOLERANCE = 0.005;

/** Which side of the path to offset towards. */
export const Side = Object.freeze({ LEFT: 'left', RIGHT: 'right' });

/**
 * What an open path can do instead of inside / outside / centre.
 *
 * `CENTER` is named to match the closed-path operation it stands in for, and it
 * is the only one that follows the drawing exactly: the tool centre is on the
 * line, so the cut is symmetric about it. The other two put the line on an edge
 * of the cut.
 */
export const OpenMode = Object.freeze({
	CENTER: 'center',
	NORMAL: 'normal',
	HEADING: 'heading',
});

/** Handedness multiplier for each side, applied to the left normal. */
const HAND = Object.freeze({ [Side.LEFT]: 1, [Side.RIGHT]: -1 });


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
 * Unit normal pointing to the left of the direction from a to b.
 *
 * @param {Number[]} a - segment start
 * @param {Number[]} b - segment end
 * @returns {Number[]} the unit left normal, or [0, 0] for a zero-length segment
 */
function leftNormal(a, b) {

	const vx = b[0] - a[0];
	const vy = b[1] - a[1];
	const length = Math.hypot(vx, vy);

	return length === 0 ? [0, 0] : [-vy / length, vx / length];
}


/**
 * Index of the outline vertex nearest a point, with how far off it was.
 *
 * @param {Array<Number[]>} outline - the closed outline
 * @param {Number[]} point - the point to find
 * @returns {Object} `{ index, distance }`
 */
function nearestVertex(outline, point) {

	let index = 0;
	let distance = Infinity;

	outline.forEach((vertex, i) => {
		const found = Math.hypot(vertex[0] - point[0], vertex[1] - point[1]);
		if (found < distance) {
			distance = found;
			index = i;
		}
	});

	return { index, distance };
}


/**
 * Walks the stretch of outline that forms one side of the path.
 *
 * A left-side cut starts square off the beginning of the path — one offset
 * distance along the left normal of the first segment — and finishes square off
 * the end. Both of those points lie ON the outline, since the round end is a
 * half-circle whose two ends are exactly them. So the side is just the arc
 * between them, taken in the direction the path itself runs.
 *
 * @param {Array<Number[]>} outline - the closed offset outline
 * @param {Array<Number[]>} source - the source path, de-duplicated
 * @param {Number} distance - the offset distance
 * @param {Number} hand - +1 for the left side, -1 for the right
 * @returns {Object} `{ path, drift }`, drift being how far the ideal start and
 *   end sat from the nearest outline vertex — normally zero, and non-zero only
 *   where the offset has merged over the end of the path
 */
function walkSide(outline, source, distance, hand) {

	const count = outline.length;
	const last = source.length - 1;

	const startNormal = leftNormal(source[0], source[1]);
	const endNormal = leftNormal(source[last - 1], source[last]);

	const wantStart = [
		source[0][0] + (hand * distance * startNormal[0]),
		source[0][1] + (hand * distance * startNormal[1]),
	];
	const wantEnd = [
		source[last][0] + (hand * distance * endNormal[0]),
		source[last][1] + (hand * distance * endNormal[1]),
	];

	const from = nearestVertex(outline, wantStart);
	const to = nearestVertex(outline, wantEnd);

	if (from.index === to.index)
		return { path: [], drift: Math.max(from.distance, to.distance) };

	// Which way round the loop? Just past the start, the side we want heads the
	// way the path heads; the other way turns back into the round end.
	const tangentX = source[1][0] - source[0][0];
	const tangentY = source[1][1] - source[0][1];
	const along = (step) => {
		const next = outline[(from.index + step + count) % count];
		return ((next[0] - outline[from.index][0]) * tangentX)
			+ ((next[1] - outline[from.index][1]) * tangentY);
	};
	const step = along(1) >= along(-1) ? 1 : -1;

	const path = [outline[from.index]];
	for (let i = from.index; i !== to.index;) {
		i = (i + step + count) % count;
		path.push(outline[i]);
	}

	return { path, drift: Math.max(from.distance, to.distance) };
}


/**
 * Offsets an open path along its normals, to one side.
 *
 * @param {Array<Number[]>} points - the source path, in millimetres
 * @param {Number} distance - offset distance; must be positive
 * @param {Object} [options] - options
 * @param {String} [options.side=Side.LEFT] - which side to offset towards
 * @param {Number} [options.tolerance=DEFAULT_TOLERANCE] - arc tolerance, millimetres
 * @returns {Object} `{ path, outline, warnings }` — the offset as ONE polyline
 *   running from one end of the source to the other, and the full closed outline
 *   it was taken from, which is the tool's whole swept area
 * @throws {RangeError} when the distance is not positive
 */
export function offsetAlongNormals(points, distance, options = {}) {

	const { side = Side.LEFT } = options;
	const both = offsetBothSides(points, distance, options);

	return {
		path: side === Side.RIGHT ? both.right : both.left,
		outline: both.outline,
		warnings: both.warnings,
	};
}


/**
 * Offsets an open path to BOTH sides at once.
 *
 * Both sides come out of the same outline, so asking for them together costs one
 * Clipper call rather than two.
 *
 * @param {Array<Number[]>} points - the source path, in millimetres
 * @param {Number} distance - offset distance; must be positive
 * @param {Object} [options] - options
 * @param {Number} [options.tolerance=DEFAULT_TOLERANCE] - arc tolerance, millimetres
 * @returns {Object} `{ left, right, outline, warnings }`, where each side is ONE
 *   polyline
 * @throws {RangeError} when the distance is not positive
 */
export function offsetBothSides(points, distance, options = {}) {

	const { tolerance = DEFAULT_TOLERANCE } = options;

	if (!(distance > 0))
		throw new RangeError(`offsetAlongNormals needs a positive distance, got ${distance}`);

	const source = dedupe(points);
	const empty = { left: [], right: [], outline: [], warnings: [] };

	if (source.length < 2)
		return empty;

	// round ends, so every point of the outline is exactly the offset distance
	// from the source and no arc of it can cut too close -- see the file header
	const outlines = offsetOpen([source], distance, {
		end: OpenEnd.ROUND,
		toleranceMm: tolerance,
	});

	if (outlines.length === 0)
		return empty;

	// the largest outline encloses the path; any others are holes in the swept
	// area, which the tool does not visit
	const outline = outlines.reduce(
		(largest, candidate) => (candidate.length > largest.length ? candidate : largest),
	);

	const left = walkSide(outline, source, distance, HAND[Side.LEFT]);
	const right = walkSide(outline, source, distance, HAND[Side.RIGHT]);

	// The square start and end normally land exactly on the outline. They do not
	// when the offset has swallowed the end of the path -- an offset so large,
	// against a shape so tight, that the end is no longer on the boundary at all.
	// The cut is still safe, but it no longer begins where it was asked to, and
	// that is not something to discover on the machine.
	const warnings = [];
	const drift = Math.max(left.drift, right.drift);
	if (drift > tolerance)
		warnings.push(`offset of ${distance}mm is large enough to swallow the end of this path;`
			+ ` the cut starts ${drift.toFixed(3)}mm from where it should`);

	return { left: left.path, right: right.path, outline, warnings };
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


/**
 * The toolpath for an open path, in any of the three modes.
 *
 * One entry point, because choosing between these is the thing a person does
 * while dialling a job in — try centre, try a normal offset one side, try the
 * other side, change the bit — and every one of them should be reachable by
 * changing one field rather than calling a different function.
 *
 * @param {Array<Number[]>} points - the source path, in millimetres
 * @param {Object} [options] - options
 * @param {String} [options.mode=OpenMode.CENTER] - which of the three
 * @param {Number} [options.distance=0] - offset distance for NORMAL and
 *   HEADING, millimetres; ignored by CENTER. For a cut whose edge lands on the
 *   drawn line this is the tool RADIUS, not its diameter
 * @param {String} [options.side=Side.LEFT] - which side, for NORMAL
 * @param {Number} [options.angleRadians=0] - heading, for HEADING
 * @param {Number} [options.tolerance=DEFAULT_TOLERANCE] - arc tolerance, for NORMAL
 * @returns {Object} `{ path, outline, warnings, congruent }`. `outline` is the
 *   tool's swept area and is only produced by NORMAL, where it falls out of the
 *   offset; for the other two it is empty rather than computed, since nothing
 *   needs it.
 *
 *   `congruent` says whether the toolpath is the source moved rigidly — true for
 *   CENTER and HEADING, false for NORMAL. Anything that has to map a position on
 *   the SOURCE to the same position on the TOOLPATH needs it. On a congruent
 *   path the mapping is arc length for arc length; on a normal offset the two
 *   paths are different lengths and nearest-point projection is the only honest
 *   correspondence. Using projection on a congruent path is wrong, and wrong in
 *   a way that looks fine until the path has a corner: a heading offset of 6mm
 *   put a tab 6mm along from where it was placed, because the nearest bit of
 *   toolpath to the tab was around the corner rather than straight ahead.
 * @throws {RangeError} for an unknown mode, or a distance the mode cannot use
 */
export function openToolpath(points, options = {}) {

	const {
		mode = OpenMode.CENTER,
		distance = 0,
		side = Side.LEFT,
		angleRadians = 0,
	} = options;

	const source = dedupe(points);

	if (mode === OpenMode.CENTER)
		return { path: source, outline: [], warnings: [], congruent: true };

	if (mode === OpenMode.HEADING) {

		if (!(distance >= 0))
			throw new RangeError(`heading offset needs a distance of zero or more, got ${distance}`);

		return {
			path: offsetByHeading(source, distance, angleRadians),
			outline: [],
			warnings: [],
			congruent: true,
		};
	}

	if (mode === OpenMode.NORMAL)
		return {
			...offsetAlongNormals(points, distance, { side, tolerance: options.tolerance }),
			congruent: false,
		};

	throw new RangeError(`unknown open-path mode '${mode}'`);
}
