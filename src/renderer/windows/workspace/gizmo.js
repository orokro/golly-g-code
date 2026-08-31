/**
 * @file gizmo.js
 * @description The arithmetic behind dragging shapes about: translate, rotate,
 * and scale.
 *
 * ---------------------------------------------------------------------------
 * The gizmo works on the SELECTION, not on a shape
 *
 * One box round everything selected, and a drag applies the same change to every
 * member of it. That is what makes "move these four holes 5mm left" one action
 * rather than four, and it falls out of the placement model: a translate adds the
 * same delta to each `offset`, and a rotate turns each shape about the SHARED
 * centre rather than about its own.
 *
 * Rotating about the shared centre is the whole difficulty. A shape's `rotation`
 * turns it about its own centre (see placement.js), so turning a group about a
 * point that is not any member's centre needs the offset moved as well — each
 * shape's centre swings round the group's, and its own rotation catches up with
 * the swing. Both parts, or four holes rotate on the spot and stay in a square.
 * ---------------------------------------------------------------------------
 *
 * ## One limitation, stated rather than discovered
 *
 * A shape's scale is applied in its OWN frame, before its rotation (placement.js
 * builds R·S). So scaling a turned shape along world X actually stretches it
 * along its own X. For uniform scaling — the common case, and the only one the
 * corner handles offer without a modifier — the two are identical. For a
 * non-uniform drag on an already-rotated shape they are not, and the result is
 * the shape stretched in its own frame.
 *
 * Getting that exactly right needs shear, which three fields cannot represent at
 * all. Storing a full matrix instead would fix it and cost the Inspector every
 * one of its readable, typeable numbers. Pinned by a test so it is a documented
 * behaviour rather than a surprise.
 *
 * Nothing here touches Vue or the DOM. It takes numbers and gives numbers back,
 * which is what makes the awkward case — a rotation of a rotated group — a test
 * rather than a thing to squint at on screen.
 */

/** What a drag is doing. */
export const Mode = Object.freeze({
	TRANSLATE: 'translate',
	ROTATE: 'rotate',
	SCALE: 'scale',
});

/** The eight scale handles, as fractions of the box. */
export const CORNERS = Object.freeze([
	{ name: 'nw', fx: 0, fy: 1 }, { name: 'n', fx: 0.5, fy: 1 }, { name: 'ne', fx: 1, fy: 1 },
	{ name: 'w', fx: 0, fy: 0.5 }, { name: 'e', fx: 1, fy: 0.5 },
	{ name: 'sw', fx: 0, fy: 0 }, { name: 's', fx: 0.5, fy: 0 }, { name: 'se', fx: 1, fy: 0 },
]);

/** How far above the box the rotate knob sits, in screen pixels. */
export const KNOB_GAP = 26;

/** The smallest scale a drag may produce, so a shape cannot be crushed to nothing. */
export const MIN_SCALE = 0.01;


/**
 * The point on a box at given fractions of its width and height.
 *
 * @param {Object} box - `{ minX, minY, maxX, maxY }`
 * @param {Number} fx - 0 at minX, 1 at maxX
 * @param {Number} fy - 0 at minY, 1 at maxY
 * @returns {Number[]} `[x, y]`
 */
export function pointOn(box, fx, fy) {
	return [
		box.minX + ((box.maxX - box.minX) * fx),
		box.minY + ((box.maxY - box.minY) * fy),
	];
}


/**
 * The centre of a box.
 *
 * @param {Object} box - `{ minX, minY, maxX, maxY }`
 * @returns {Number[]} `[x, y]`
 */
export function centreOfBox(box) {
	return pointOn(box, 0.5, 0.5);
}


/**
 * A translation, as the change to make to each shape.
 *
 * @param {Number[]} from - where the drag started, in millimetres
 * @param {Number[]} to - where the pointer is now
 * @param {Object} [options] - options
 * @param {Boolean} [options.axisLock] - constrain to the larger of X and Y
 * @returns {Object} `{ dx, dy }`
 */
export function translation(from, to, options = {}) {

	let dx = to[0] - from[0];
	let dy = to[1] - from[1];

	// Shift locks to an axis, which is what it does everywhere else. Chosen by
	// which way the pointer has actually gone furthest rather than by which it
	// went first — deciding on the first pixel makes it feel like a coin toss.
	if (options.axisLock === true) {
		if (Math.abs(dx) >= Math.abs(dy))
			dy = 0;
		else
			dx = 0;
	}

	return { dx, dy };
}


/**
 * The angle a rotate drag has turned through.
 *
 * @param {Number[]} centre - the pivot, in millimetres
 * @param {Number[]} from - where the drag started
 * @param {Number[]} to - where the pointer is now
 * @param {Object} [options] - options
 * @param {Number} [options.snapRadians] - round to this, for a modifier key
 * @returns {Number} radians, positive anticlockwise
 */
export function rotation(centre, from, to, options = {}) {

	const before = Math.atan2(from[1] - centre[1], from[0] - centre[0]);
	const after = Math.atan2(to[1] - centre[1], to[0] - centre[0]);

	const turned = after - before;
	const { snapRadians } = options;

	if (!(snapRadians > 0))
		return turned;

	return Math.round(turned / snapRadians) * snapRadians;
}


/**
 * The scale factors a corner drag asks for, and the point it pivots about.
 *
 * The pivot is the OPPOSITE corner, so the one you are not holding stays put —
 * which is what dragging a corner looks like it should do. Holding the centre
 * still instead makes the box grow both ways and the far corner run away.
 *
 * @param {Object} box - the selection bounds when the drag started
 * @param {Object} corner - one of {@link CORNERS}
 * @param {Number[]} to - where the pointer is now, in millimetres
 * @param {Object} [options] - options
 * @param {Boolean} [options.uniform] - keep the aspect ratio
 * @param {Boolean} [options.fromCentre] - pivot about the centre instead
 * @returns {Object} `{ sx, sy, pivot }`
 */
export function scaling(box, corner, to, options = {}) {

	const { uniform = false, fromCentre = false } = options;

	const pivot = fromCentre
		? centreOfBox(box)
		: pointOn(box, 1 - corner.fx, 1 - corner.fy);

	const held = pointOn(box, corner.fx, corner.fy);

	// An edge handle moves one axis; the other keeps its size. Dividing by a zero
	// span would give Infinity, so a degenerate box simply does not scale.
	const spanX = held[0] - pivot[0];
	const spanY = held[1] - pivot[1];

	let sx = spanX === 0 ? 1 : (to[0] - pivot[0]) / spanX;
	let sy = spanY === 0 ? 1 : (to[1] - pivot[1]) / spanY;

	if (uniform) {
		// the axis that actually moved decides, so a corner drag does not jitter
		// between the two when one of them barely changed
		const factor = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
		sx = spanX === 0 ? 1 : factor;
		sy = spanY === 0 ? 1 : factor;
	}

	return {
		sx: clampScale(sx),
		sy: clampScale(sy),
		pivot,
	};
}


/**
 * Keeps a scale factor away from zero, preserving which way round it is.
 *
 * A mirrored shape is a real thing to want, so a negative factor is allowed
 * through; a zero one is not, because nothing can be recovered from it.
 *
 * @param {Number} value - the factor
 * @returns {Number} the usable factor
 */
function clampScale(value) {

	if (!Number.isFinite(value))
		return 1;

	const sign = value < 0 ? -1 : 1;

	return sign * Math.max(Math.abs(value), MIN_SCALE);
}


/**
 * The new placement fields for one shape under a drag.
 *
 * Takes the shape's placement as it was when the drag STARTED, so every move is
 * computed from the same origin rather than accumulating — twenty moves of a
 * degree each must land on twenty degrees, not on twenty roundings of a degree.
 *
 * @param {Object} start - the shape's `{ offset, rotation, scale }` at drag start
 * @param {Number[]} centre - the shape's own centre, untransformed
 * @param {Object} change - what the drag asks for
 * @param {String} change.mode - one of {@link Mode}
 * @param {Number} [change.dx] - translate
 * @param {Number} [change.dy] - translate
 * @param {Number} [change.radians] - rotate
 * @param {Number} [change.sx] - scale
 * @param {Number} [change.sy] - scale
 * @param {Number[]} [change.pivot] - the point to turn or scale about
 * @returns {Object} the fields to set
 */
export function applyDrag(start, centre, change) {

	const offset = start.offset ?? { x: 0, y: 0 };
	const rotationNow = start.rotation ?? 0;
	const scale = start.scale ?? { x: 1, y: 1 };

	if (change.mode === Mode.TRANSLATE)
		return { offset: { x: offset.x + change.dx, y: offset.y + change.dy } };

	// Where this shape's centre currently is, which is what swings round the
	// pivot. A shape's own rotation turns it in place; moving it round a pivot
	// that is not its centre is the offset's job, and doing only one of the two
	// is how four holes rotate on the spot and stay in a square.
	const at = [centre[0] + offset.x, centre[1] + offset.y];
	const pivot = change.pivot ?? at;

	if (change.mode === Mode.ROTATE) {

		const cos = Math.cos(change.radians);
		const sin = Math.sin(change.radians);
		const rx = at[0] - pivot[0];
		const ry = at[1] - pivot[1];

		const moved = [
			pivot[0] + (cos * rx) - (sin * ry),
			pivot[1] + (sin * rx) + (cos * ry),
		];

		return {
			rotation: rotationNow + change.radians,
			offset: { x: moved[0] - centre[0], y: moved[1] - centre[1] },
		};
	}

	const moved = [
		pivot[0] + ((at[0] - pivot[0]) * change.sx),
		pivot[1] + ((at[1] - pivot[1]) * change.sy),
	];

	return {
		scale: { x: scale.x * change.sx, y: scale.y * change.sy },
		offset: { x: moved[0] - centre[0], y: moved[1] - centre[1] },
	};
}
