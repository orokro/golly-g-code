/**
 * @file fit.js
 * @description Refits a polyline as lines and circular arcs, for G2/G3.
 *
 * ## Why this is the biggest cut-quality item in the plan
 *
 * By the time a toolpath reaches the post-processor it is a polyline, because
 * Clipper offsets polygons and knows nothing about curves. So every curve in the
 * program is a few thousand chords, each one an individual `G1`. That is bad in
 * three separate ways, and only one of them is file size:
 *
 * 1. **The controller decelerates at every corner.** A planner looks ahead a
 *    fixed number of blocks; feed thousands of 0.05mm moves into it and it
 *    cannot see far enough ahead to keep the feed up. The cut slows, and an
 *    uneven feed against a spinning cutter is exactly what leaves witness marks.
 * 2. **Serial streaming becomes the bottleneck.** GRBL has a small receive
 *    buffer. A file of tiny moves can starve the planner regardless of what the
 *    machine could physically do.
 * 3. The file is ten times bigger than it needs to be.
 *
 * A real arc is one block that the controller interpolates itself, at full feed.
 *
 * ## The tolerance is a budget, and it has to be shared
 *
 * Two things push the emitted arc away from the polyline, and they ADD:
 * how far each vertex sits off the fitted circle, and how far the arc bows away
 * from the straight chord between two vertices. Checking each against the full
 * tolerance separately lets the total reach twice it — measured 0.0134mm on a
 * 0.01mm tolerance, and no amount of output precision moved it, which is how it
 * was identified. Each check gets half the budget so the promise on the label is
 * the promise that holds.
 *
 * ## What "within tolerance" is measured against
 *
 * The ORIGINAL points, always. It would be easy to fit an arc to three of them
 * and check only those three — the fit passes by construction and says nothing.
 * Every point in the span is checked against the fitted arc, and the span only
 * grows while all of them hold.
 *
 * Three further checks that a radial-distance test alone will not catch, each of
 * which produces an arc that goes somewhere else entirely:
 *
 * - **The arc must stay near the SEGMENTS, not just the vertices.** This is the
 *   one that matters most, and it is the same mistake that broke the open-path
 *   offset twice: the tool follows the line between two points, and a test that
 *   only looks at points says nothing about it. Fit a circle through three
 *   points and all three lie on it by construction — the check passes and has
 *   asked nothing. A right-angled corner is three points, so on Greg's skyline
 *   this turned a corner into a SEMICIRCLE bulging 5.15mm off the path, and
 *   every vertex was exactly on it. The chord between consecutive points is
 *   checked by its sagitta, which is how far the arc bows away from the straight
 *   move the polyline actually describes.
 * - **The points must advance around the arc monotonically.** A path that
 *   doubles back sits at the same radius on the way out and the way home, so
 *   every point passes the distance test while the arc through them describes a
 *   different journey.
 * - **The sweep stops short of half a turn.** At exactly half a turn the two
 *   endpoints are diametrically opposite, `atan2` cannot tell +pi from -pi, and
 *   which way round the arc goes becomes a coin flip. Stopping short of it
 *   costs one extra block on a semicircle and removes the ambiguity.
 */

/** Default deviation allowed between the fitted arc and the original points. */
export const DEFAULT_TOLERANCE = 0.01;

/**
 * Widest sweep emitted as a single arc.
 *
 * Short of half a turn on purpose. At exactly pi the endpoints are diametrically
 * opposite and the direction is not recoverable from them.
 */
const MAX_SWEEP = Math.PI * 0.95;

/**
 * Radius above which an arc is not worth having.
 *
 * A very flat arc is a straight line with a huge, numerically delicate centre
 * far off the work. Controllers handle those badly and a line is a better
 * description of the same geometry.
 */
const MAX_RADIUS = 10_000;


/**
 * The circle through three points.
 *
 * @param {Number[]} a - first point
 * @param {Number[]} b - second point
 * @param {Number[]} c - third point
 * @returns {Object|null} `{ centre, radius }`, or null when they are collinear
 */
export function circleThrough(a, b, c) {

	const d = 2 * ((a[0] * (b[1] - c[1])) + (b[0] * (c[1] - a[1])) + (c[0] * (a[1] - b[1])));

	if (Math.abs(d) < 1e-12)
		return null;

	const aa = (a[0] * a[0]) + (a[1] * a[1]);
	const bb = (b[0] * b[0]) + (b[1] * b[1]);
	const cc = (c[0] * c[0]) + (c[1] * c[1]);

	const centre = [
		((aa * (b[1] - c[1])) + (bb * (c[1] - a[1])) + (cc * (a[1] - b[1]))) / d,
		((aa * (c[0] - b[0])) + (bb * (a[0] - c[0])) + (cc * (b[0] - a[0]))) / d,
	];

	return { centre, radius: Math.hypot(a[0] - centre[0], a[1] - centre[1]) };
}


/**
 * Furthest any point strays from the straight line between two others.
 *
 * @param {Array<Number[]>} points - the whole path
 * @param {Number} from - first index of the span
 * @param {Number} to - last index of the span
 * @returns {Number} the largest deviation, millimetres
 */
function straightness(points, from, to) {

	const [ax, ay] = points[from];
	const [bx, by] = points[to];
	const vx = bx - ax;
	const vy = by - ay;
	const length = Math.hypot(vx, vy);

	if (length === 0)
		return Infinity;

	let worst = 0;

	for (let i = from + 1; i < to; i++) {
		const [px, py] = points[i];
		worst = Math.max(worst, Math.abs(((px - ax) * vy) - ((py - ay) * vx)) / length);
	}

	return worst;
}


/**
 * Tries to describe one span of the path as a single arc.
 *
 * @param {Array<Number[]>} points - the whole path
 * @param {Number} from - first index of the span
 * @param {Number} to - last index of the span
 * @param {Number} tolerance - allowed deviation, millimetres
 * @returns {Object|null} the arc, or null when this span is not one
 */
function arcThrough(points, from, to, tolerance) {

	if (to - from < 2)
		return null;

	const middle = points[from + Math.floor((to - from) / 2)];
	const circle = circleThrough(points[from], middle, points[to]);

	if (circle === null || !(circle.radius <= MAX_RADIUS))
		return null;

	const { centre, radius } = circle;

	// the two contributions add, so neither gets the whole budget
	const share = tolerance / 2;
	const angleOf = (p) => Math.atan2(p[1] - centre[1], p[0] - centre[0]);

	// which way round, taken from the first step and then required of the rest
	const start = angleOf(points[from]);
	const step = (angle) => {
		let delta = angle - start;
		while (delta > Math.PI) delta -= 2 * Math.PI;
		while (delta < -Math.PI) delta += 2 * Math.PI;
		return delta;
	};

	const firstStep = step(angleOf(points[from + 1]));
	if (firstStep === 0)
		return null;

	const clockwise = firstStep < 0;
	let previous = 0;

	for (let i = from + 1; i <= to; i++) {

		// every point on the arc, not just the three it was built from
		if (Math.abs(Math.hypot(points[i][0] - centre[0], points[i][1] - centre[1]) - radius) > share)
			return null;

		// AND near the straight move between them. The tool travels the chord,
		// not the vertices, and an arc can pass exactly through every vertex
		// while bowing far away from the path in between -- which is what a
		// right-angled corner does, since three points always lie on a circle.
		const chord = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
		const half = chord / 2;
		if (half >= radius)
			return null;
		if (radius - Math.sqrt((radius * radius) - (half * half)) > share)
			return null;

		// and advancing the same way round, so a path that doubles back over
		// itself cannot masquerade as an arc
		const swept = clockwise ? -step(angleOf(points[i])) : step(angleOf(points[i]));
		if (swept <= previous || swept > MAX_SWEEP)
			return null;

		previous = swept;
	}

	return { type: 'arc', to: points[to], centre, radius, clockwise, sweep: previous };
}


/**
 * Refits a polyline as a sequence of lines and arcs.
 *
 * Greedy and longest-first: each segment is extended as far as the tolerance
 * allows before the next one starts. The search doubles the span until it fails
 * and then bisects, so a long smooth curve does not cost a quadratic scan.
 *
 * @param {Array<Number[]>} points - the polyline, in millimetres
 * @param {Object} [options] - options
 * @param {Number} [options.tolerance=DEFAULT_TOLERANCE] - allowed deviation
 * @returns {Array<Object>} segments, each `{ type: 'line', to }` or
 *   `{ type: 'arc', to, centre, radius, clockwise, sweep }`. The start point is
 *   the path's first point and is not repeated
 * @throws {RangeError} when the tolerance is not positive
 */
export function fitArcs(points, options = {}) {

	const { tolerance = DEFAULT_TOLERANCE } = options;

	if (!(tolerance > 0))
		throw new RangeError(`fitArcs needs a positive tolerance, got ${tolerance}`);

	if (points.length < 2)
		return [];

	const segments = [];
	let from = 0;

	while (from < points.length - 1) {

		const fits = (to) => straightness(points, from, to) <= tolerance
			|| arcThrough(points, from, to, tolerance) !== null;

		// double until it breaks, then bisect: a smooth curve of a thousand
		// points costs log(1000) probes rather than a thousand
		let good = from + 1;
		let span = 1;

		while (good + span <= points.length - 1 && fits(good + span)) {
			good += span;
			span *= 2;
		}

		let low = good;
		let high = Math.min(good + span, points.length - 1);

		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (fits(middle))
				low = middle;
			else
				high = middle - 1;
		}

		const to = Math.max(low, from + 1);

		// a line wins ties: it is one word shorter and every controller agrees
		// about what it means
		if (straightness(points, from, to) <= tolerance)
			segments.push({ type: 'line', to: points[to] });
		else
			segments.push(arcThrough(points, from, to, tolerance));

		from = to;
	}

	return segments;
}


/**
 * Furthest the fitted segments stray from the original points.
 *
 * The check the fitting itself cannot perform, since it would be marking its own
 * homework: this walks the ORIGINAL points and measures each against whichever
 * fitted segment covers it.
 *
 * @param {Array<Number[]>} points - the original polyline
 * @param {Array<Object>} segments - the output of fitArcs
 * @returns {Number} the largest deviation, millimetres
 */
export function fitError(points, segments) {

	if (points.length < 2 || segments.length === 0)
		return 0;

	let worst = 0;
	let index = 0;
	let start = points[0];

	for (const segment of segments) {

		// the original points this segment stands in for
		const end = segment.to;
		const covered = [];
		while (index < points.length && points[index] !== end)
			covered.push(points[index++]);
		covered.push(end);
		index++;

		for (const point of covered) {
			if (segment.type === 'arc') {
				worst = Math.max(worst, Math.abs(
					Math.hypot(point[0] - segment.centre[0], point[1] - segment.centre[1])
					- segment.radius));
			} else {
				const vx = end[0] - start[0];
				const vy = end[1] - start[1];
				const length = Math.hypot(vx, vy);
				if (length > 0)
					worst = Math.max(worst,
						Math.abs(((point[0] - start[0]) * vy) - ((point[1] - start[1]) * vx)) / length);
			}
		}

		start = end;
	}

	return worst;
}
