/**
 * @file depth.js
 * @description Splits a total cut depth into a series of passes.
 *
 * Deliberately separate from the toolpath geometry. For every operation we
 * support, depth is orthogonal to the XY path: the same outline is traced once
 * per pass at a progressively lower Z. Keeping them apart means the geometry
 * code never thinks about Z, and the emitter never thinks about offsetting.
 *
 * V-carving is the exception, since its Z varies continuously along the path,
 * which is one more reason not to entangle the two now: bolting a per-point Z
 * onto a shared depth list later would be worse than adding an operation kind
 * that carries its own.
 */

/**
 * Computes the Z of each pass, deepest last.
 *
 * The final pass lands exactly on the target depth rather than overshooting or
 * stopping short. A short last pass is normal and correct, and much better than
 * cutting 0.4mm deeper than asked because the total did not divide evenly.
 *
 * @param {Number} cutDepth - total depth to cut, positive millimetres
 * @param {Number} passDepth - maximum depth removed per pass, positive millimetres
 * @param {Object} [options] - options
 * @param {Number} [options.topZ=0] - Z of the material surface
 * @returns {Number[]} the Z value of each pass, descending
 * @throws {RangeError} when either depth is not positive, or would need absurdly many passes
 */
export function computeDepthPasses(cutDepth, passDepth, options = {}) {

	const { topZ = 0 } = options;

	if (!(cutDepth > 0))
		throw new RangeError(`cutDepth must be positive, got ${cutDepth}`);

	if (!(passDepth > 0))
		throw new RangeError(`passDepth must be positive, got ${passDepth}`);

	if (cutDepth / passDepth > 10_000)
		throw new RangeError(`passDepth ${passDepth} is far too small for a cut depth of ${cutDepth}`);

	const bottomZ = topZ - cutDepth;

	/** @type {Number[]} */
	const passes = [];

	let z = topZ;

	while (z > bottomZ) {
		z = Math.max(z - passDepth, bottomZ);
		passes.push(z);
	}

	return passes;
}


/**
 * Describes whether a cut goes through the material.
 *
 * Not an error. Cutting slightly through is how you make sure a part actually
 * separates, and cutting well through on purpose is a real technique when the
 * spoilboard has been prepared for it. This reports the fact so a UI can show
 * it, rather than deciding on the user's behalf.
 *
 * @param {Number} cutDepth - total depth to cut, positive millimetres
 * @param {Number} materialThickness - stock thickness, positive millimetres
 * @param {Number} [allowance=0] - depth past the material the user intends to cut
 * @returns {Object} `{ cutsThrough, overshoot, beyondAllowance }`
 */
export function describeThroughCut(cutDepth, materialThickness, allowance = 0) {

	const overshoot = cutDepth - materialThickness;

	return {
		cutsThrough: overshoot >= 0,
		overshoot,
		beyondAllowance: overshoot > allowance,
	};
}
