/**
 * @file matrix.js
 * @description 2D affine transforms, in SVG's own six-number form.
 *
 * A matrix is `[a, b, c, d, e, f]`, standing for
 *
 *     | a  c  e |
 *     | b  d  f |
 *     | 0  0  1 |
 *
 * which is the order SVG's `matrix()` function uses, so a matrix read out of a
 * document needs no rearranging.
 *
 * We compose transforms numerically rather than concatenating transform strings
 * and re-parsing them at the end. Both work, but a document nested twenty groups
 * deep would otherwise build a string twenty transforms long for every single
 * path, and a numeric matrix also lets callers ask useful questions — whether
 * scaling is uniform, whether the transform flips handedness — that a string
 * cannot answer.
 */

/** The identity transform: changes nothing. */
export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/**
 * Recognised transform functions and how many numbers each accepts.
 *
 * Used to reject a call with the wrong arity rather than silently ignoring the
 * extras, which is how geometry ends up quietly in the wrong place.
 */
const ARITY = Object.freeze({
	matrix: [6],
	translate: [1, 2],
	scale: [1, 2],
	rotate: [1, 3],
	skewX: [1],
	skewY: [1],
});

/** Splits a transform list into individual `name(args)` calls. */
const CALL_PATTERN = /([a-zA-Z]+)\s*\(([^)]*)\)/g;


/**
 * Multiplies two matrices, giving the transform that applies `second` in the
 * coordinate space established by `first`.
 *
 * In SVG terms: for `transform="A B"`, and for a child B nested inside a parent
 * A, the effective transform is `multiply(A, B)`.
 *
 * @param {Number[]} first - the outer transform
 * @param {Number[]} second - the inner transform
 * @returns {Number[]} the combined matrix
 */
export function multiply(first, second) {

	const [a1, b1, c1, d1, e1, f1] = first;
	const [a2, b2, c2, d2, e2, f2] = second;

	return [
		(a1 * a2) + (c1 * b2),
		(b1 * a2) + (d1 * b2),
		(a1 * c2) + (c1 * d2),
		(b1 * c2) + (d1 * d2),
		(a1 * e2) + (c1 * f2) + e1,
		(b1 * e2) + (d1 * f2) + f1,
	];
}


/**
 * Applies a matrix to a point.
 *
 * @param {Number[]} matrix - the transform
 * @param {Number[]} point - the point as [x, y]
 * @returns {Number[]} the transformed point as [x, y]
 */
export function applyToPoint(matrix, point) {

	const [a, b, c, d, e, f] = matrix;
	return [
		(a * point[0]) + (c * point[1]) + e,
		(b * point[0]) + (d * point[1]) + f,
	];
}


/**
 * Builds a translation matrix.
 *
 * @param {Number} tx - x offset
 * @param {Number} [ty=0] - y offset
 * @returns {Number[]} the matrix
 */
export function fromTranslate(tx, ty = 0) {

	return [1, 0, 0, 1, tx, ty];
}


/**
 * Builds a scale matrix.
 *
 * @param {Number} sx - x scale
 * @param {Number} [sy] - y scale; defaults to `sx`, matching SVG's `scale(n)`
 * @returns {Number[]} the matrix
 */
export function fromScale(sx, sy = sx) {

	return [sx, 0, 0, sy, 0, 0];
}


/**
 * Builds a rotation matrix, optionally about a point other than the origin.
 *
 * @param {Number} degrees - rotation angle in degrees, clockwise in SVG's y-down space
 * @param {Number} [cx=0] - centre x
 * @param {Number} [cy=0] - centre y
 * @returns {Number[]} the matrix
 */
export function fromRotate(degrees, cx = 0, cy = 0) {

	const radians = degrees * Math.PI / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);

	const rotation = [cos, sin, -sin, cos, 0, 0];

	if (cx === 0 && cy === 0)
		return rotation;

	// rotate about (cx, cy): move it to the origin, rotate, move it back
	return multiply(multiply(fromTranslate(cx, cy), rotation), fromTranslate(-cx, -cy));
}


/**
 * Builds a horizontal skew matrix.
 *
 * @param {Number} degrees - skew angle in degrees
 * @returns {Number[]} the matrix
 */
export function fromSkewX(degrees) {

	return [1, 0, Math.tan(degrees * Math.PI / 180), 1, 0, 0];
}


/**
 * Builds a vertical skew matrix.
 *
 * @param {Number} degrees - skew angle in degrees
 * @returns {Number[]} the matrix
 */
export function fromSkewY(degrees) {

	return [1, Math.tan(degrees * Math.PI / 180), 0, 1, 0, 0];
}


/**
 * Parses an SVG `transform` attribute into a single matrix.
 *
 * Throws rather than ignoring anything it does not understand. A transform that
 * is silently dropped puts geometry somewhere other than the artwork says, with
 * no indication — and the first sign of it is a ruined workpiece.
 *
 * @param {String|null|undefined} value - the raw transform attribute
 * @returns {Number[]} the combined matrix; identity for an empty value
 * @throws {Error} when the value cannot be fully parsed
 */
export function parseTransformList(value) {

	if (value === null || value === undefined)
		return [...IDENTITY];

	const text = String(value).trim();
	if (text === '')
		return [...IDENTITY];

	let result = [...IDENTITY];
	let found = false;

	CALL_PATTERN.lastIndex = 0;

	let match = CALL_PATTERN.exec(text);
	while (match !== null) {

		const [, name, rawArgs] = match;

		if (Object.prototype.hasOwnProperty.call(ARITY, name) === false)
			throw new Error(`Unknown transform function "${name}" in "${text}"`);

		const args = rawArgs
			.trim()
			.split(/[\s,]+/)
			.filter((token) => token !== '')
			.map(Number);

		if (args.some((n) => Number.isFinite(n) === false))
			throw new Error(`Non-numeric argument to ${name}() in "${text}"`);

		if (ARITY[name].includes(args.length) === false)
			throw new Error(`${name}() takes ${ARITY[name].join(' or ')} arguments, got ${args.length}`);

		result = multiply(result, buildTransform(name, args));

		found = true;
		match = CALL_PATTERN.exec(text);
	}

	if (found === false)
		throw new Error(`Could not parse transform "${text}"`);

	// anything left over is not whitespace or separators, so we did not
	// understand the whole thing and must not pretend otherwise
	const remainder = text.replace(CALL_PATTERN, '').replace(/[\s,]/g, '');
	if (remainder !== '')
		throw new Error(`Unparsed content "${remainder}" in transform "${text}"`);

	return result;
}


/**
 * Builds the matrix for one parsed transform call.
 *
 * @param {String} name - the transform function name
 * @param {Number[]} args - its numeric arguments
 * @returns {Number[]} the matrix
 */
function buildTransform(name, args) {

	switch (name) {
		case 'matrix': return args.slice(0, 6);
		case 'translate': return fromTranslate(args[0], args.length > 1 ? args[1] : 0);
		case 'scale': return fromScale(args[0], args.length > 1 ? args[1] : args[0]);
		case 'rotate': return args.length === 3 ? fromRotate(args[0], args[1], args[2]) : fromRotate(args[0]);
		case 'skewX': return fromSkewX(args[0]);
		case 'skewY': return fromSkewY(args[0]);
		default: throw new Error(`Unhandled transform "${name}"`);
	}
}


/**
 * The signed area scale factor of a matrix.
 *
 * A negative determinant means the transform flips handedness, which matters for
 * cut direction: a mirrored shape reverses its winding, turning a climb cut into
 * a conventional one.
 *
 * @param {Number[]} matrix - the transform
 * @returns {Number} the determinant
 */
export function determinant(matrix) {

	return (matrix[0] * matrix[3]) - (matrix[1] * matrix[2]);
}


/**
 * Whether a matrix scales both axes equally and without shear.
 *
 * Useful because a circle stays a circle under a uniform transform but becomes
 * an ellipse otherwise.
 *
 * @param {Number[]} matrix - the transform
 * @param {Number} [epsilon=1e-9] - comparison tolerance
 * @returns {Boolean} true when scaling is uniform
 */
export function isUniformScale(matrix, epsilon = 1e-9) {

	const [a, b, c, d] = matrix;

	const scaleX = Math.hypot(a, b);
	const scaleY = Math.hypot(c, d);

	// a shear shows up as the two basis vectors no longer being perpendicular
	const shear = (a * c) + (b * d);

	return Math.abs(scaleX - scaleY) <= epsilon && Math.abs(shear) <= epsilon;
}


/**
 * Formats a matrix as an SVG `matrix(...)` string.
 *
 * @param {Number[]} matrix - the transform
 * @returns {String} the SVG transform string
 */
export function toTransformString(matrix) {

	return `matrix(${matrix.join(',')})`;
}
