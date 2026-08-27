/**
 * @file arc.js
 * @description Elliptical arc handling — centre parameterization and exact
 * flattening.
 *
 * ## Why arcs are not converted to beziers
 *
 * The obvious pipeline is to turn every arc into cubics up front (svgpath offers
 * `unarc()` for exactly this) and have one curve type downstream. We did that
 * first, and a test measuring a flattened circle against its *true* radius caught
 * the problem: a cubic can only approximate a circular arc, with radial error
 * around 0.00027 x radius per quadrant. That error is invisible to the flattener,
 * which faithfully stays within tolerance of the cubics it was handed — of an
 * already-wrong curve. On a 50mm circle the two errors stacked to 0.0111mm
 * against a 0.01mm tolerance, and nothing in the pipeline would have said so.
 *
 * Holes and filleted corners are most of what a router cuts, so being quietly
 * over tolerance on every one of them is not acceptable.
 *
 * Keeping arcs as a first-class segment type fixes it two ways:
 *
 *   - Flattening an arc analytically gives an exact error bound, because the
 *     sagitta of a circular segment has a closed form.
 *   - An arc that survives to the post-processor can be emitted as a real G2/G3
 *     move instead of a fitted approximation, which is a smaller file and a
 *     smoother cut. jscut never emits an arc at all.
 *
 * The maths here is the SVG specification's endpoint-to-centre conversion
 * (Implementation Notes F.6.5), which is fiddly but entirely mechanical.
 */

/** Full turn in radians. */
const TAU = Math.PI * 2;


/**
 * @typedef {Object} CentreArc
 * @property {Number[]} centre - ellipse centre [cx, cy]
 * @property {Number} rx - x radius, after any spec-mandated correction
 * @property {Number} ry - y radius, after any spec-mandated correction
 * @property {Number} rotation - x-axis rotation, radians
 * @property {Number} startAngle - start parameter, radians
 * @property {Number} deltaAngle - swept parameter, radians; signed
 */


/**
 * Signed angle between two vectors.
 *
 * @param {Number} ux - first vector x
 * @param {Number} uy - first vector y
 * @param {Number} vx - second vector x
 * @param {Number} vy - second vector y
 * @returns {Number} the angle in radians, in (-PI, PI]
 */
function angleBetween(ux, uy, vx, vy) {

	const dot = (ux * vx) + (uy * vy);
	const len = Math.sqrt(((ux * ux) + (uy * uy)) * ((vx * vx) + (vy * vy)));

	if (len === 0)
		return 0;

	// clamp against floating point drift pushing the ratio outside acos's domain
	let ratio = dot / len;
	ratio = Math.max(-1, Math.min(1, ratio));

	const sign = ((ux * vy) - (uy * vx)) < 0 ? -1 : 1;
	return sign * Math.acos(ratio);
}


/**
 * Converts an SVG arc from endpoint parameterization to centre parameterization.
 *
 * Implements SVG 1.1 Implementation Notes F.6.5 and F.6.6, including the
 * out-of-range radius correction: if the given radii are too small to span the
 * endpoints, they are scaled up uniformly until they exactly reach, rather than
 * the arc being rejected.
 *
 * @param {Number[]} from - start point [x, y]
 * @param {Number} rx - x radius as authored
 * @param {Number} ry - y radius as authored
 * @param {Number} rotationDegrees - x-axis rotation in degrees, as authored
 * @param {Boolean} largeArc - the large-arc flag
 * @param {Boolean} sweep - the sweep flag
 * @param {Number[]} to - end point [x, y]
 * @returns {CentreArc|null} the centre form, or null if the arc degenerates to a line
 */
export function endpointToCentre(from, rx, ry, rotationDegrees, largeArc, sweep, to) {

	// spec: a zero radius means "treat this as a straight line"
	if (rx === 0 || ry === 0)
		return null;

	// spec: coincident endpoints mean the arc is simply omitted
	if (from[0] === to[0] && from[1] === to[1])
		return null;

	rx = Math.abs(rx);
	ry = Math.abs(ry);

	const rotation = (rotationDegrees % 360) * Math.PI / 180;
	const cosR = Math.cos(rotation);
	const sinR = Math.sin(rotation);

	// step 1: translate so the midpoint is the origin, and rotate into the
	// ellipse's own frame
	const dx = (from[0] - to[0]) / 2;
	const dy = (from[1] - to[1]) / 2;

	const x1p = (cosR * dx) + (sinR * dy);
	const y1p = (-sinR * dx) + (cosR * dy);

	// step 2: enlarge radii that are too small to reach between the endpoints
	const lambda = ((x1p * x1p) / (rx * rx)) + ((y1p * y1p) / (ry * ry));
	if (lambda > 1) {
		const scale = Math.sqrt(lambda);
		rx *= scale;
		ry *= scale;
	}

	// step 3: locate the centre in the rotated frame
	const rxSq = rx * rx;
	const rySq = ry * ry;
	const x1pSq = x1p * x1p;
	const y1pSq = y1p * y1p;

	const numerator = Math.max(0, (rxSq * rySq) - (rxSq * y1pSq) - (rySq * x1pSq));
	const denominator = (rxSq * y1pSq) + (rySq * x1pSq);

	const coefficient = (largeArc === sweep ? -1 : 1) * Math.sqrt(
		denominator === 0 ? 0 : numerator / denominator,
	);

	const cxp = coefficient * ((rx * y1p) / ry);
	const cyp = coefficient * (-(ry * x1p) / rx);

	// step 4: rotate the centre back out into user space
	const centre = [
		(cosR * cxp) - (sinR * cyp) + ((from[0] + to[0]) / 2),
		(sinR * cxp) + (cosR * cyp) + ((from[1] + to[1]) / 2),
	];

	// step 5: start angle and swept angle
	const ux = (x1p - cxp) / rx;
	const uy = (y1p - cyp) / ry;
	const vx = (-x1p - cxp) / rx;
	const vy = (-y1p - cyp) / ry;

	const startAngle = angleBetween(1, 0, ux, uy);
	let deltaAngle = angleBetween(ux, uy, vx, vy);

	// the sweep flag decides which way round the ellipse we actually travel
	if (sweep === false && deltaAngle > 0)
		deltaAngle -= TAU;
	else if (sweep === true && deltaAngle < 0)
		deltaAngle += TAU;

	return { centre, rx, ry, rotation, startAngle, deltaAngle };
}


/**
 * Evaluates a point on a centre-parameterized arc.
 *
 * @param {CentreArc} arc - the arc
 * @param {Number} angle - the parameter, radians
 * @returns {Number[]} the point as [x, y]
 */
export function arcPoint(arc, angle) {

	const cosR = Math.cos(arc.rotation);
	const sinR = Math.sin(arc.rotation);
	const cosA = Math.cos(angle);
	const sinA = Math.sin(angle);

	return [
		arc.centre[0] + (arc.rx * cosA * cosR) - (arc.ry * sinA * sinR),
		arc.centre[1] + (arc.rx * cosA * sinR) + (arc.ry * sinA * cosR),
	];
}


/**
 * Chooses the angular step that keeps an arc's chords within a distance
 * tolerance.
 *
 * For a circle of radius r, a chord spanning angle t sits at most
 * `r * (1 - cos(t/2))` inside the true arc — the sagitta. Inverting that gives
 * the largest step meeting a tolerance directly, with no iteration:
 *
 *     t = 2 * acos(1 - tolerance / r)
 *
 * For an ellipse the local radius of curvature varies, so we use the largest
 * radius. That is conservative — the flatter end of the ellipse gets more points
 * than it strictly needs — which is the correct direction to be wrong in.
 *
 * @param {CentreArc} arc - the arc
 * @param {Number} tolerance - maximum permitted deviation
 * @returns {Number} the angular step in radians, always positive
 */
export function arcAngularStep(arc, tolerance) {

	const radius = Math.max(arc.rx, arc.ry);

	// an arc flatter than the tolerance needs no subdivision at all
	if (radius <= tolerance)
		return TAU;

	const ratio = Math.max(-1, Math.min(1, 1 - (tolerance / radius)));
	const step = 2 * Math.acos(ratio);

	// guard against a pathologically tiny step from a near-zero tolerance
	return Math.max(step, 1e-4);
}


/**
 * Flattens an arc into points, excluding the start point.
 *
 * Excludes the start because the caller has already emitted it as the previous
 * segment's endpoint; emitting it again would create a zero-length segment.
 *
 * The final point is set to the arc's exact endpoint rather than an evaluated
 * one, so that consecutive segments join without a floating-point gap.
 *
 * @param {CentreArc} arc - the arc
 * @param {Number[]} to - the exact endpoint, used verbatim for the last point
 * @param {Number} tolerance - maximum permitted deviation
 * @returns {Array<Number[]>} the points after the start, ending exactly at `to`
 */
export function flattenArc(arc, to, tolerance) {

	const step = arcAngularStep(arc, tolerance);
	const sweep = Math.abs(arc.deltaAngle);

	const count = Math.max(1, Math.ceil(sweep / step));
	const direction = arc.deltaAngle < 0 ? -1 : 1;
	const increment = sweep / count;

	const points = [];

	for (let i = 1; i < count; i++)
		points.push(arcPoint(arc, arc.startAngle + (direction * increment * i)));

	points.push([to[0], to[1]]);

	return points;
}
