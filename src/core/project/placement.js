/**
 * @file placement.js
 * @description Where a shape sits, as a transform on the NODE rather than as
 * rewritten path data.
 *
 * ---------------------------------------------------------------------------
 * Why not just move the points
 *
 * plan.md says to drag with a transform and "commit path data only on release",
 * and that is right about the performance: re-serialising a large `d` on every
 * mousemove is the one reliable way to make SVG feel slow. It is wrong about
 * where the truth should end up, and the reason is `prepareSvgReimport`.
 *
 * Changing an SvgDoc's resolution re-reads the kept original at the new DPI and
 * KEEPS the path node ids. If dragging had rewritten the geometry, that re-read
 * would silently throw away every placement the user had made — a data-loss bug
 * with no error and no undo entry to point at. The original geometry stays
 * exactly as imported; where it sits is a property of the node.
 *
 * It also means undo is free. Geometry lives in a side store that the history's
 * node driver does not snapshot; three numbers on a node are snapshotted like
 * any other field.
 *
 * The cost is real and worth naming: every consumer of geometry now has to ask
 * for the matrix. There are three — the toolpath gatherer, the workspace
 * renderer, and zoom-to-fit — and forgetting one shows up as a cut in the wrong
 * place, which is why `gather` is the ONLY place in the core that reads
 * geometry for cutting.
 * ---------------------------------------------------------------------------
 *
 * ## The order, and the origin
 *
 * `scale`, then `rotate`, then `translate`, all about the shape's own centre.
 * Rotating about the centre is what a person means by "rotate this"; rotating
 * about the drawing's origin sends the shape across the bed.
 *
 * The centre is the shape's UNTRANSFORMED bounds centre, computed rather than
 * stored. Geometry never changes, so it is stable — and storing it would be a
 * second thing to keep in step for no gain.
 *
 * A matrix is `[a, b, c, d, e, f]`, the SVG convention, so it can go straight
 * into a `transform` attribute:
 *
 *     x' = a·x + c·y + e
 *     y' = b·x + d·y + f
 */

import { boundsOfSubPaths, unionBounds } from '../path/bounds.js';
import { NodeType } from './nodes.js';
import { childrenOf, ancestorsOf } from './tree.js';
import { resolvedValues } from './inherit.js';

/** The transform that does nothing. */
export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/** The node types that carry a placement. */
export const PLACEABLE = Object.freeze([NodeType.SVG_PATH, NodeType.SVG_DOC, NodeType.JOB]);


/**
 * Multiplies two matrices — `a` applied after `b`.
 *
 * @param {Number[]} a - the outer transform
 * @param {Number[]} b - the inner transform
 * @returns {Number[]} the combined matrix
 */
export function compose(a, b) {

	return [
		(a[0] * b[0]) + (a[2] * b[1]),
		(a[1] * b[0]) + (a[3] * b[1]),
		(a[0] * b[2]) + (a[2] * b[3]),
		(a[1] * b[2]) + (a[3] * b[3]),
		(a[0] * b[4]) + (a[2] * b[5]) + a[4],
		(a[1] * b[4]) + (a[3] * b[5]) + a[5],
	];
}


/**
 * Applies a matrix to a point.
 *
 * @param {Number[]} m - the matrix
 * @param {Number[]} point - `[x, y]`
 * @returns {Number[]} the moved point
 */
export function apply(m, point) {

	return [
		(m[0] * point[0]) + (m[2] * point[1]) + m[4],
		(m[1] * point[0]) + (m[3] * point[1]) + m[5],
	];
}


/**
 * Whether a matrix is the identity, to within floating-point noise.
 *
 * Worth asking: the overwhelmingly common case is a shape nobody has moved, and
 * skipping the whole transform for it keeps the untouched path exactly as
 * imported rather than run through six multiplications per point.
 *
 * @param {Number[]} m - the matrix
 * @returns {Boolean} true when it does nothing
 */
export function isIdentity(m) {
	return IDENTITY.every((value, i) => Math.abs(m[i] - value) < 1e-12);
}


/**
 * Builds a matrix from a node's placement fields.
 *
 * @param {Object} values - `{ offset, rotation, scale }`, any may be missing
 * @param {Number[]} centre - `[x, y]` to rotate and scale about
 * @returns {Number[]} the matrix
 */
export function localMatrix(values, centre) {

	const offset = values?.offset ?? { x: 0, y: 0 };
	const rotation = values?.rotation ?? 0;
	const scale = values?.scale ?? { x: 1, y: 1 };

	const sx = scale.x ?? 1;
	const sy = scale.y ?? 1;
	const cos = Math.cos(rotation);
	const sin = Math.sin(rotation);

	// scale then rotate, so the linear part is R·S
	const a = cos * sx;
	const b = sin * sx;
	const c = -sin * sy;
	const d = cos * sy;

	// ...about the centre, then translated: T(offset) · T(c) · R·S · T(-c)
	const [cx, cy] = centre ?? [0, 0];

	return [
		a, b, c, d,
		(offset.x ?? 0) + cx - ((a * cx) + (c * cy)),
		(offset.y ?? 0) + cy - ((b * cx) + (d * cy)),
	];
}


/**
 * The untransformed bounds of a node's own geometry.
 *
 * For an SvgDoc that is the union of its children, because a drawing rotates
 * about the middle of the drawing rather than about the middle of whichever
 * path happens to be first.
 *
 * @param {Object} project - `{ document, geometry }`
 * @param {String} id - the node
 * @returns {Object|null} `{ minX, minY, maxX, maxY }`, or null
 */
export function localBounds(project, id) {

	const node = project.document.nodes[id];

	if (node === undefined)
		return null;

	// a job owns its outline exactly as a path does, and for the same reason:
	// both are "a shape that sits somewhere"
	if (node.type === NodeType.SVG_PATH || node.type === NodeType.JOB)
		return boundsOfSubPaths(project.geometry?.[node.geometry]?.subPaths ?? []);

	return unionBounds(childrenOf(project.document, id)
		.map((child) => localBounds(project, child.id))
		.filter((box) => box !== null));
}


/**
 * The centre a node rotates and scales about.
 *
 * @param {Object} project - `{ document, geometry }`
 * @param {String} id - the node
 * @returns {Number[]} `[x, y]`; the origin when the node has no geometry
 */
export function centreOf(project, id) {

	const box = localBounds(project, id);

	return box === null
		? [0, 0]
		: [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
}


/**
 * The full matrix for a node, including everything it sits inside.
 *
 * A path inside a drawing that has itself been moved gets both, outermost
 * first — moving the drawing moves its paths, the same way hiding a folder
 * hides what is in it.
 *
 * @param {Object} project - `{ document, geometry }`
 * @param {String} id - the node
 * @returns {Number[]} the matrix
 */
export function matrixFor(project, id) {

	const { document } = project;
	const chain = [...ancestorsOf(document, id), document.nodes[id]]
		.filter((node) => node !== undefined && PLACEABLE.includes(node.type));

	let matrix = IDENTITY;

	for (const node of chain)
		matrix = compose(matrix,
			localMatrix(resolvedValues(document, node.id), centreOf(project, node.id)));

	return matrix;
}


/**
 * Pulls a matrix apart into the three fields that made it.
 *
 * The inverse of {@link localMatrix}, and exact for anything that function can
 * produce — which is rotation and scale about a centre, plus a translation. It
 * is used when a job takes on the placement of the path it was made from, so the
 * job appears exactly where the path was and its own numbers read sensibly.
 *
 * A rotation composed with a NON-UNIFORM scale at two different levels can
 * produce shear, and shear is not expressible in three fields at all — this
 * returns the closest thing that is. That is the same limitation gizmo.js
 * documents, arrived at from the other direction.
 *
 * @param {Number[]} m - the matrix
 * @param {Number[]} centre - the centre it should be expressed about
 * @returns {Object} `{ offset, rotation, scale }`
 */
export function decompose(m, centre) {

	const [a, b, c, d, e, f] = m;
	const [cx, cy] = centre ?? [0, 0];

	const rotation = Math.atan2(b, a);
	const sx = Math.hypot(a, b);

	// a mirrored transform has a negative determinant, and the sign has to land
	// on one axis or the other -- Y by convention, so a rotation stays a rotation
	const determinant = (a * d) - (b * c);
	const sy = Math.hypot(c, d) * (determinant < 0 ? -1 : 1);

	return {
		offset: {
			x: e - cx + ((a * cx) + (c * cy)),
			y: f - cy + ((b * cx) + (d * cy)),
		},
		rotation,
		scale: { x: sx, y: sy },
	};
}


/**
 * A matrix as an SVG `transform` attribute.
 *
 * @param {Number[]} m - the matrix
 * @returns {String} the attribute value, empty for the identity
 */
export function svgTransform(m) {

	if (isIdentity(m))
		return '';

	return `matrix(${m.map((value) => Number(value.toFixed(6))).join(' ')})`;
}


/**
 * Moves a box's four corners and takes the bounds of the result.
 *
 * Not the two opposite corners: a rotated box's extent is decided by all four,
 * and using two gives a box that is too small at every angle but a right one.
 *
 * @param {Object|null} box - `{ minX, minY, maxX, maxY }`
 * @param {Number[]} m - the matrix
 * @returns {Object|null} the transformed bounds
 */
export function transformBounds(box, m) {

	if (box === null || box === undefined)
		return null;

	const corners = [
		apply(m, [box.minX, box.minY]),
		apply(m, [box.maxX, box.minY]),
		apply(m, [box.maxX, box.maxY]),
		apply(m, [box.minX, box.maxY]),
	];

	const xs = corners.map((point) => point[0]);
	const ys = corners.map((point) => point[1]);

	return {
		minX: Math.min(...xs), maxX: Math.max(...xs),
		minY: Math.min(...ys), maxY: Math.max(...ys),
	};
}
