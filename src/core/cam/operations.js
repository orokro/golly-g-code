/**
 * @file operations.js
 * @description Turns closed geometry into toolpaths.
 *
 * The five closed-path operations, all of them producing the same shape of
 * result: a set of 2D contours plus the list of Z depths to trace them at.
 * Depth lives in depth.js and never mixes with the offsetting here.
 *
 * ## Cut direction, and why it flips
 *
 * "Climb" and "conventional" describe how the cutting edge meets the material,
 * not which way round a loop you travel — so the travel direction that produces
 * climb milling is opposite for an outside cut and an inside one.
 *
 * With a normal right-hand cutter spinning clockwise seen from above:
 *
 *   - Cutting the OUTSIDE of a boundary (material on the inside of the path),
 *     climb means travelling clockwise.
 *   - Cutting the INSIDE of a boundary — a pocket wall, or a hole — the material
 *     is on the outside of the path, so climb means travelling counter-clockwise.
 *
 * A hole inside a profile cut is therefore an inside cut even though the
 * operation is "outside". Clipper hands back holes wound opposite to their
 * outers, so reversing every contour together preserves that relationship and
 * gets both right at once. jscut arrives at the same place with a bare
 * `needReverse = isInside ? climb : !climb`, which is correct but says nothing
 * about why.
 *
 * ## Everything is normalized first
 *
 * Every operation unions its input before offsetting. Self-intersecting artwork
 * offsets into slivers, and a compound shape authored as one contour with a
 * zero-width bridge needs the bridge resolved — otherwise an engrave would
 * follow it and slit the part.
 */

import {
	offsetClosed, normalize, signedArea, reverse, Join,
} from '../geometry/clipper.js';
import { computeDepthPasses } from './depth.js';

/** The closed-path operations. */
export const Operation = Object.freeze({
	OUTSIDE: 'outside',
	INSIDE: 'inside',
	CENTER: 'center',
	ENGRAVE: 'engrave',
	POCKET: 'pocket',
});

/** Cut directions. */
export const Direction = Object.freeze({
	CLIMB: 'climb',
	CONVENTIONAL: 'conventional',
});

/** Operations whose tool runs inside the boundary, for direction purposes. */
const INSIDE_OPERATIONS = Object.freeze([Operation.INSIDE, Operation.POCKET]);

/** Ceiling on pocket rings, so a tiny stepover cannot spin forever. */
const MAX_POCKET_RINGS = 2000;


/**
 * Orients contours so the cut runs the requested way round.
 *
 * Reverses the whole set together or not at all, which keeps holes wound
 * opposite to their outers and so cutting the correct way for their own side.
 *
 * @param {Array<Array<Number[]>>} polygons - contours from Clipper
 * @param {String} direction - one of {@link Direction}
 * @param {Boolean} toolInside - true when the tool runs inside the boundary
 * @returns {Array<Array<Number[]>>} contours, possibly all reversed
 */
export function orientForCut(polygons, direction, toolInside) {

	if (polygons.length === 0)
		return polygons;

	const climb = direction === Direction.CLIMB;

	// see the file header: the travel direction giving climb milling is opposite
	// for an inside cut and an outside one
	const wantOuterClockwise = toolInside ? !climb : climb;

	// Clipper returns outers with positive area in our y-up space
	const outer = polygons.find((polygon) => signedArea(polygon) > 0) ?? polygons[0];
	const outerIsClockwise = signedArea(outer) < 0;

	if (outerIsClockwise === wantOuterClockwise)
		return polygons;

	return polygons.map((polygon) => reverse(polygon));
}


/**
 * Builds the offset distances for a band of passes.
 *
 * A `width` of zero or less gives a single pass at the tool radius. Anything
 * wider is cleared in steps, with the last pass landing exactly on the far edge
 * of the band rather than overshooting it.
 *
 * @param {Number} radius - tool radius in millimetres
 * @param {Number} margin - extra material to leave, millimetres
 * @param {Number} width - band width to clear, millimetres
 * @param {Number} stepover - fraction of tool diameter per step, 0 to 1
 * @returns {Number[]} offset distances, all positive, nearest the shape first
 */
export function bandOffsets(radius, margin, width, stepover) {

	const first = radius + margin;

	if (!(width > radius * 2))
		return [first];

	// the tool centre can reach from one radius inside the band to one radius
	// short of its far edge
	const last = margin + width - radius;
	const step = Math.max(radius * 2 * stepover, 1e-6);

	const offsets = [];

	for (let d = first; d < last; d += step)
		offsets.push(d);

	offsets.push(last);

	return offsets;
}


/**
 * Generates a toolpath for one closed-path operation.
 *
 * @param {Array<Array<Number[]>>} polygons - closed contours in millimetres
 * @param {Object} settings - operation settings
 * @param {String} settings.operation - one of {@link Operation}
 * @param {Number} settings.toolDiameter - tool diameter in millimetres
 * @param {Number} settings.cutDepth - total depth to cut, positive millimetres
 * @param {Number} settings.passDepth - maximum depth per pass, positive millimetres
 * @param {Number} [settings.margin=0] - material to leave uncut; negative cuts extra
 * @param {Number} [settings.width=0] - band width for inside/outside
 * @param {Number} [settings.stepover=0.4] - fraction of tool diameter per step
 * @param {String} [settings.direction=Direction.CONVENTIONAL] - cut direction
 * @param {String} [settings.fillRule='nonzero'] - fill rule of the source artwork
 * @param {Number} [settings.topZ=0] - Z of the material surface
 * @param {String} [settings.join=Join.ROUND] - corner style for offsets
 * @returns {Object} `{ operation, paths, depths, warnings, settings }`
 * @throws {TypeError} when the operation is unknown
 */
export function generateToolpath(polygons, settings) {

	const {
		operation,
		toolDiameter,
		cutDepth,
		passDepth,
		margin = 0,
		width = 0,
		stepover = 0.4,
		direction = Direction.CONVENTIONAL,
		fillRule = 'nonzero',
		topZ = 0,
		join = Join.ROUND,
	} = settings;

	if (Object.values(Operation).includes(operation) === false)
		throw new TypeError(`Unknown operation "${operation}"`);

	if (!(toolDiameter > 0))
		throw new RangeError(`toolDiameter must be positive, got ${toolDiameter}`);

	if (!(stepover > 0) || stepover > 1)
		throw new RangeError(`stepover must be in (0, 1], got ${stepover}`);

	const radius = toolDiameter / 2;

	/** @type {String[]} */
	const warnings = [];

	// resolve self-intersections and bridges before anything is offset
	const source = polygons.length > 0 ? normalize(polygons, fillRule) : [];

	if (polygons.length > 0 && source.length === 0)
		warnings.push('The geometry enclosed no area once cleaned up');

	if (polygons.length === 1 && source.length > 1) {
		warnings.push(
			`A single contour resolved into ${source.length} loops — it is a compound `
			+ 'shape written with a zero-width bridge. The bridge has been removed.',
		);
	}

	const offsetOptions = { join, toleranceMm: settings.toleranceMm };

	/** @type {Array<Array<Number[]>>} */
	let rings = [];

	switch (operation) {

		case Operation.OUTSIDE:
			for (const distance of bandOffsets(radius, margin, width, stepover))
				rings.push(...offsetClosed(source, distance, offsetOptions));
			break;

		case Operation.INSIDE:
			for (const distance of bandOffsets(radius, margin, width, stepover))
				rings.push(...offsetClosed(source, -distance, offsetOptions));
			break;

		case Operation.CENTER:
			// on the line, shifted only by whatever margin was asked for
			rings = margin === 0 ? source : offsetClosed(source, margin, offsetOptions);
			break;

		case Operation.ENGRAVE:
			// trace the artwork exactly; margin is meaningless here, and the
			// normalize above is what makes this bridge-safe
			rings = source;
			break;

		case Operation.POCKET:
			rings = pocketRings(source, radius, margin, stepover, offsetOptions, warnings);
			break;

		default:
			throw new TypeError(`Unhandled operation "${operation}"`);
	}

	if (rings.length === 0 && source.length > 0) {
		warnings.push(
			`Nothing left to cut: a ${toolDiameter}mm tool does not fit this shape `
			+ (margin !== 0 ? `with a ${margin}mm margin` : 'at this offset'),
		);
	}

	const toolInside = INSIDE_OPERATIONS.includes(operation);
	const paths = orientForCut(rings, direction, toolInside)
		.map((points) => ({ points, closed: true }));

	return {
		operation,
		paths,
		depths: computeDepthPasses(cutDepth, passDepth, { topZ }),
		warnings,
		settings: { toolDiameter, margin, width, stepover, direction, topZ },
	};
}


/**
 * Builds concentric rings that clear the inside of a shape.
 *
 * Every ring is offset from the ORIGINAL boundary rather than from the previous
 * ring. Chaining offsets accumulates rounding — measured at 2710nm of drift over
 * 100 passes against 10nm computing from the original — and a pocket is exactly
 * the operation that would do it most.
 *
 * Rings come back innermost first, so the plunge happens in the middle of the
 * pocket where there is room for it rather than against a wall.
 *
 * @param {Array<Array<Number[]>>} source - the cleaned boundary
 * @param {Number} radius - tool radius in millimetres
 * @param {Number} margin - material to leave against the wall
 * @param {Number} stepover - fraction of tool diameter per ring
 * @param {Object} offsetOptions - forwarded to the offsetter
 * @param {String[]} warnings - collected warnings, appended to in place
 * @returns {Array<Array<Number[]>>} rings, innermost first
 */
function pocketRings(source, radius, margin, stepover, offsetOptions, warnings) {

	const step = radius * 2 * stepover;

	/** @type {Array<Array<Number[]>>} */
	const rings = [];

	let distance = radius + margin;

	while (rings.length < MAX_POCKET_RINGS) {

		const ring = offsetClosed(source, -distance, offsetOptions);

		if (ring.length === 0)
			break;

		rings.push(ring);
		distance += step;
	}

	if (rings.length >= MAX_POCKET_RINGS)
		warnings.push(`Pocket stopped at ${MAX_POCKET_RINGS} rings; is the stepover too small?`);

	// innermost first: plunge in open space, then work outward
	return rings.reverse().flat();
}
