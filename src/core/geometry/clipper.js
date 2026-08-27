/**
 * @file clipper.js
 * @description Polygon offsetting and boolean operations, in millimetres.
 *
 * Wraps `clipper2-ts`, which works in integers, behind an API that works in the
 * float millimetres the rest of the core uses. Everything about the integer
 * representation — the scale factor, the range limits, the enum spellings — stops
 * here.
 *
 * ## Why this library
 *
 * Measured, not assumed. `clipper2-js` returns mathematically wrong geometry:
 * inward-offsetting a plain square produces garbage for every join type, and a
 * shape smaller than the offset fails to vanish. Both wasm bindings
 * (`clipper2-wasm`, `js-angusj-clipper`) need a full `'unsafe-eval'` CSP because
 * Emscripten's glue calls `new Function` at module init — and a Worker inherits
 * the document's CSP, so moving the work off-thread would not escape it. Pure JS
 * is what lets the app keep a tight CSP, and it still runs 25-35% faster than the
 * `clipper-lib` jscut shipped.
 *
 * ## The scale factor
 *
 * One integer unit is 1e-4 mm (100 nanometres). Clipper's float64 fast path stays
 * exact to +/-47,453,132 units, so the usable extent is about +/-4745 mm — nearly
 * four times a 1200mm workspace. Resolution is roughly ten times finer than any
 * hobby machine resolves, so this is never the limiting factor on accuracy.
 *
 * Clipper does NOT throw when coordinates exceed its exact range; it silently
 * loses precision. So we range-check the input ourselves.
 *
 * ## Two behaviours worth knowing
 *
 * **Round joins are inscribed.** An arc approximated at a given tolerance always
 * falls *inside* the true arc, so an outward offset comes out marginally
 * undersized. Where clearance actually matters, pass `compensateInscribedArcs`.
 *
 * **Offsets must not be chained.** Offsetting an already-offset result
 * accumulates rounding: measured over 100 passes, chaining drifts 2710nm while
 * computing each pass from the original stays at 10nm. `offsetSeries` exists so
 * pocket clearing cannot get this wrong by accident.
 */

import { inflatePaths, booleanOp, makePath, JoinType, EndType, ClipType, FillRule } from 'clipper2-ts';

/** Integer units per millimetre. One unit is 100 nanometres. */
export const SCALE = 10_000;

/**
 * Largest coordinate magnitude Clipper handles exactly, in integer units.
 *
 * This is floor(sqrt(2^53)/2), the bound at which its area sums stay exact.
 */
export const MAX_SAFE_UNITS = 47_453_132;

/** The same limit expressed in millimetres, which is what callers think in. */
export const MAX_SAFE_MILLIMETERS = MAX_SAFE_UNITS / SCALE;

/** Default arc tolerance for round joins, in millimetres. */
export const DEFAULT_ARC_TOLERANCE = 0.005;

/** How an offset treats the ends of an open path. */
export const OpenEnd = Object.freeze({
	BUTT: 'butt',
	SQUARE: 'square',
	ROUND: 'round',
	JOINED: 'joined',
});

/** Our open-end names mapped onto the library's enum. */
const END_TYPE = Object.freeze({
	[OpenEnd.BUTT]: EndType.Butt,
	[OpenEnd.SQUARE]: EndType.Square,
	[OpenEnd.ROUND]: EndType.Round,
	[OpenEnd.JOINED]: EndType.Joined,
});

/** Corner styles for offsetting. */
export const Join = Object.freeze({
	ROUND: 'round',
	MITER: 'miter',
	SQUARE: 'square',
	BEVEL: 'bevel',
});

/** Our join names mapped onto the library's enum. */
const JOIN_TYPE = Object.freeze({
	[Join.ROUND]: JoinType.Round,
	[Join.MITER]: JoinType.Miter,
	[Join.SQUARE]: JoinType.Square,
	[Join.BEVEL]: JoinType.Bevel,
});

/** SVG fill rules mapped onto the library's enum. */
const FILL_RULE = Object.freeze({
	nonzero: FillRule.NonZero,
	evenodd: FillRule.EvenOdd,
});


/**
 * Checks that a set of polygons is finite and within Clipper's exact range.
 *
 * Clipper silently degrades past its range rather than complaining, so this is
 * the only thing standing between an oversized document and quietly wrong
 * geometry.
 *
 * @param {Array<Array<Number[]>>} polygons - polygons in millimetres
 * @param {String} what - a label for the error message
 * @returns {void}
 * @throws {RangeError} when a coordinate is non-finite or out of range
 */
function assertUsable(polygons, what) {

	if (Array.isArray(polygons) === false)
		throw new TypeError(`${what}: expected an array of polygons`);

	for (const polygon of polygons) {

		if (Array.isArray(polygon) === false)
			throw new TypeError(`${what}: expected each polygon to be an array of points`);

		for (const point of polygon) {

			const x = point[0];
			const y = point[1];

			if (Number.isFinite(x) === false || Number.isFinite(y) === false)
				throw new RangeError(`${what}: non-finite coordinate (${x}, ${y})`);

			if (Math.abs(x) > MAX_SAFE_MILLIMETERS || Math.abs(y) > MAX_SAFE_MILLIMETERS)
				throw new RangeError(
					`${what}: coordinate (${x}, ${y}) exceeds the exact range of `
					+ `+/-${MAX_SAFE_MILLIMETERS}mm. Clipper does not report this itself; `
					+ 'it silently loses precision.',
				);
		}
	}
}


/**
 * Converts millimetre polygons into Clipper paths.
 *
 * Polygons with too few points are dropped: they enclose no area, and passing a
 * one-point path to the offsetter throws an unhelpful raw TypeError from inside
 * the library.
 *
 * @param {Array<Array<Number[]>>} polygons - polygons in millimetres
 * @param {Number} minimumPoints - fewest points a path must have to be kept
 * @returns {Array<Object>} Clipper paths
 */
function toClipper(polygons, minimumPoints) {

	const result = [];

	for (const polygon of polygons) {

		if (polygon.length < minimumPoints)
			continue;

		const flat = new Array(polygon.length * 2);

		for (let i = 0; i < polygon.length; i++) {
			flat[i * 2] = Math.round(polygon[i][0] * SCALE);
			flat[(i * 2) + 1] = Math.round(polygon[i][1] * SCALE);
		}

		result.push(makePath(flat));
	}

	return result;
}


/**
 * Converts Clipper paths back into millimetre polygons.
 *
 * @param {Array<Object>} paths - Clipper paths
 * @returns {Array<Array<Number[]>>} polygons in millimetres
 */
function fromClipper(paths) {

	return paths.map((path) => path.map((point) => [point.x / SCALE, point.y / SCALE]));
}


/**
 * Resolves an arc tolerance in millimetres into Clipper units.
 *
 * @param {Number} toleranceMm - the tolerance in millimetres
 * @returns {Number} the tolerance in Clipper units, at least 1
 */
function arcToleranceUnits(toleranceMm) {

	return Math.max(1, Math.round(toleranceMm * SCALE));
}


/**
 * Offsets closed polygons inward or outward.
 *
 * Pass outers and holes together in one call — Clipper reads their winding to
 * tell them apart, so offsetting a shape and its holes separately gives the
 * wrong answer.
 *
 * @param {Array<Array<Number[]>>} polygons - closed polygons in millimetres
 * @param {Number} deltaMm - offset distance; positive grows, negative shrinks
 * @param {Object} [options] - options
 * @param {String} [options.join=Join.ROUND] - corner style
 * @param {Number} [options.toleranceMm] - arc tolerance for round joins
 * @param {Number} [options.miterLimit=2] - miter limit, for miter joins
 * @param {Boolean} [options.compensateInscribedArcs=false] - enlarge an outward
 *   offset by the arc tolerance, so approximation error cannot eat into clearance
 * @returns {Array<Array<Number[]>>} the offset polygons; empty if the shape vanished
 */
export function offsetClosed(polygons, deltaMm, options = {}) {

	assertUsable(polygons, 'offsetClosed');

	const {
		join = Join.ROUND,
		toleranceMm = DEFAULT_ARC_TOLERANCE,
		miterLimit = 2,
		compensateInscribedArcs = false,
	} = options;

	const paths = toClipper(polygons, 3);
	if (paths.length === 0)
		return [];

	// a round join's polygonal arc is inscribed, so an outward offset is
	// fractionally undersized; nudge it out where that matters
	const compensation = (compensateInscribedArcs === true && deltaMm > 0) ? toleranceMm : 0;
	const delta = Math.round((deltaMm + compensation) * SCALE);

	return fromClipper(inflatePaths(
		paths,
		delta,
		JOIN_TYPE[join] ?? JoinType.Round,
		EndType.Polygon,
		miterLimit,
		arcToleranceUnits(toleranceMm),
	));
}


/**
 * Offsets open polylines, producing closed outlines around them.
 *
 * This is the capability jscut lacks entirely — it force-closes every contour,
 * so an open path becomes a degenerate zero-area shape rather than a line to
 * follow. `OpenEnd.ROUND` traces the true swept area of a round endmill.
 *
 * @param {Array<Array<Number[]>>} polylines - open polylines in millimetres
 * @param {Number} deltaMm - offset distance; must be positive
 * @param {Object} [options] - options
 * @param {String} [options.end=OpenEnd.ROUND] - how the ends are capped
 * @param {String} [options.join=Join.ROUND] - corner style
 * @param {Number} [options.toleranceMm] - arc tolerance for round joins
 * @param {Number} [options.miterLimit=2] - miter limit, for miter joins
 * @returns {Array<Array<Number[]>>} closed outlines in millimetres
 * @throws {RangeError} when the offset is not positive
 */
export function offsetOpen(polylines, deltaMm, options = {}) {

	assertUsable(polylines, 'offsetOpen');

	if (!(deltaMm > 0))
		throw new RangeError(`offsetOpen needs a positive offset, got ${deltaMm}`);

	const {
		end = OpenEnd.ROUND,
		join = Join.ROUND,
		toleranceMm = DEFAULT_ARC_TOLERANCE,
		miterLimit = 2,
	} = options;

	if (Object.prototype.hasOwnProperty.call(END_TYPE, end) === false)
		throw new TypeError(`Unknown open-end style "${end}"`);

	// a single point is legitimate here: with round ends it becomes a disc, which
	// is exactly what a drilled or engraved dot should be
	const paths = toClipper(polylines, end === OpenEnd.ROUND ? 1 : 2);
	if (paths.length === 0)
		return [];

	return fromClipper(inflatePaths(
		paths,
		Math.round(deltaMm * SCALE),
		JOIN_TYPE[join] ?? JoinType.Round,
		END_TYPE[end],
		miterLimit,
		arcToleranceUnits(toleranceMm),
	));
}


/**
 * Offsets the SAME source geometry by a series of distances.
 *
 * Exists to make a specific mistake impossible. Pocket clearing wants rings at
 * increasing depths, and the obvious implementation offsets each ring from the
 * previous one — which accumulates rounding error. Measured over 100 passes:
 * chaining drifts 2710nm, computing each from the original stays at 10nm.
 *
 * @param {Array<Array<Number[]>>} polygons - the ORIGINAL closed polygons
 * @param {Number[]} deltasMm - offset distances, each measured from the original
 * @param {Object} [options] - options, forwarded to `offsetClosed`
 * @returns {Array<Array<Array<Number[]>>>} one polygon set per delta
 */
export function offsetSeries(polygons, deltasMm, options = {}) {

	return deltasMm.map((delta) => offsetClosed(polygons, delta, options));
}


/**
 * Runs a boolean operation between two polygon sets.
 *
 * @param {String} clipType - one of 'union', 'intersection', 'difference', 'xor'
 * @param {Array<Array<Number[]>>} subject - the subject polygons
 * @param {Array<Array<Number[]>>} clip - the clip polygons
 * @param {String} [fillRule='nonzero'] - 'nonzero' or 'evenodd'
 * @returns {Array<Array<Number[]>>} the resulting polygons
 */
function boolean(clipType, subject, clip, fillRule = 'nonzero') {

	assertUsable(subject, `${clipType} subject`);
	assertUsable(clip, `${clipType} clip`);

	const subjectPaths = toClipper(subject, 3);
	const clipPaths = toClipper(clip, 3);

	if (subjectPaths.length === 0 && clipPaths.length === 0)
		return [];

	const rule = FILL_RULE[String(fillRule).toLowerCase()];
	if (rule === undefined)
		throw new TypeError(`Unknown fill rule "${fillRule}"`);

	return fromClipper(booleanOp(ClipType[clipType], subjectPaths, clipPaths, rule));
}


/**
 * Unions polygon sets together.
 *
 * @param {Array<Array<Number[]>>} subject - the subject polygons
 * @param {Array<Array<Number[]>>} [clip=[]] - optional additional polygons
 * @param {String} [fillRule='nonzero'] - 'nonzero' or 'evenodd'
 * @returns {Array<Array<Number[]>>} the union
 */
export function union(subject, clip = [], fillRule = 'nonzero') {

	return boolean('Union', subject, clip, fillRule);
}


/**
 * Intersects two polygon sets.
 *
 * @param {Array<Array<Number[]>>} subject - the subject polygons
 * @param {Array<Array<Number[]>>} clip - the clip polygons
 * @param {String} [fillRule='nonzero'] - 'nonzero' or 'evenodd'
 * @returns {Array<Array<Number[]>>} the intersection
 */
export function intersection(subject, clip, fillRule = 'nonzero') {

	return boolean('Intersection', subject, clip, fillRule);
}


/**
 * Subtracts the clip polygons from the subject polygons.
 *
 * @param {Array<Array<Number[]>>} subject - the subject polygons
 * @param {Array<Array<Number[]>>} clip - the polygons to remove
 * @param {String} [fillRule='nonzero'] - 'nonzero' or 'evenodd'
 * @returns {Array<Array<Number[]>>} the difference
 */
export function difference(subject, clip, fillRule = 'nonzero') {

	return boolean('Difference', subject, clip, fillRule);
}


/**
 * Exclusive-ors two polygon sets.
 *
 * @param {Array<Array<Number[]>>} subject - the subject polygons
 * @param {Array<Array<Number[]>>} clip - the clip polygons
 * @param {String} [fillRule='nonzero'] - 'nonzero' or 'evenodd'
 * @returns {Array<Array<Number[]>>} the symmetric difference
 */
export function xor(subject, clip, fillRule = 'nonzero') {

	return boolean('Xor', subject, clip, fillRule);
}


/**
 * Cleans imported geometry into well-formed polygons.
 *
 * Self-intersecting paths are common in real artwork, and offsetting one
 * directly produces spurious slivers — measured on a simple bowtie, three
 * fragments instead of one shape. A union against nothing resolves the
 * self-intersections first. Run this on anything that came out of an SVG before
 * offsetting it.
 *
 * The fill rule matters here and should come from the source document, not be
 * assumed: it is what decides whether overlapping subpaths are holes or solid.
 *
 * @param {Array<Array<Number[]>>} polygons - closed polygons in millimetres
 * @param {String} [fillRule='nonzero'] - the fill rule from the source artwork
 * @returns {Array<Array<Number[]>>} cleaned polygons
 */
export function normalize(polygons, fillRule = 'nonzero') {

	return union(polygons, [], fillRule);
}


/**
 * Signed area of a polygon, in square millimetres.
 *
 * The sign gives the winding direction, which is what decides climb versus
 * conventional cutting.
 *
 * @param {Array<Number[]>} polygon - a closed polygon in millimetres
 * @returns {Number} the signed area; positive for counter-clockwise
 */
export function signedArea(polygon) {

	if (polygon.length < 3)
		return 0;

	let total = 0;

	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++)
		total += (polygon[j][0] * polygon[i][1]) - (polygon[i][0] * polygon[j][1]);

	return total / 2;
}


/**
 * Whether a polygon winds clockwise.
 *
 * In our y-up space, a clockwise outer boundary is a negative signed area.
 *
 * @param {Array<Number[]>} polygon - a closed polygon in millimetres
 * @returns {Boolean} true when the winding is clockwise
 */
export function isClockwise(polygon) {

	return signedArea(polygon) < 0;
}


/**
 * Reverses a polygon's winding.
 *
 * @param {Array<Number[]>} polygon - a polygon
 * @returns {Array<Number[]>} a reversed copy
 */
export function reverse(polygon) {

	return [...polygon].reverse();
}
