/**
 * @file bounds.js
 * @description The rectangle a shape occupies.
 *
 * In core rather than beside the renderer that first wanted it, because four
 * separate things need it and they are not all UI: zooming to fit (Phase 4),
 * sizing the 2D preview in real units (Phase 6), placing the stock block in 3D
 * (Phase 8), and telling the user how big an imported drawing came out — which
 * is the only way to tell whether the resolution it was read at was right.
 *
 * CONTROL-POINT bounds for cubics. A bezier lies inside the hull of its control
 * points, so this is always a true bound and sometimes a loose one. That is the
 * right trade for every one of those uses: a zoom-to-fit should leave room
 * anyway, and a tight bound means solving for the curve's extrema, which is real
 * work in exchange for being slightly wrong in the other direction.
 */

/**
 * The rectangle a shape's subpaths occupy.
 *
 * @param {Object[]} subPaths - subpaths from `normalizePathData`
 * @returns {Object|null} `{ minX, minY, maxX, maxY }`, or null when empty
 */
export function boundsOfSubPaths(subPaths) {

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;

	/**
	 * Widens the box to include a point.
	 *
	 * @param {Number[]} point - `[x, y]`
	 */
	const include = (point) => {
		minX = Math.min(minX, point[0]);
		minY = Math.min(minY, point[1]);
		maxX = Math.max(maxX, point[0]);
		maxY = Math.max(maxY, point[1]);
	};

	for (const subPath of subPaths ?? []) {

		if (subPath?.segments === undefined)
			continue;

		include(subPath.start);

		for (const segment of subPath.segments) {

			include(segment.to);

			if (segment.type === 'C') {
				include(segment.c1);
				include(segment.c2);
			}

			// the whole circle the arc is a piece of, which is a bound and a cheap
			// one. `centre` is a POINT, not a pair of cx/cy properties -- reading
			// it as the latter gives undefined, then NaN, then a null box, and
			// then a view that silently will not zoom to anything
			if (segment.type === 'A') {
				const [cx, cy] = segment.arc.centre;
				const r = Math.max(segment.arc.rx, segment.arc.ry);
				include([cx - r, cy - r]);
				include([cx + r, cy + r]);
			}
		}
	}

	return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}


/**
 * The rectangle several boxes occupy together.
 *
 * @param {Array<Object|null>} boxes - bounds, nulls ignored
 * @returns {Object|null} the union, or null when there is nothing
 */
export function unionBounds(boxes) {

	const real = boxes.filter((box) => box !== null && box !== undefined);

	if (real.length === 0)
		return null;

	return {
		minX: Math.min(...real.map((b) => b.minX)),
		minY: Math.min(...real.map((b) => b.minY)),
		maxX: Math.max(...real.map((b) => b.maxX)),
		maxY: Math.max(...real.map((b) => b.maxY)),
	};
}


/**
 * Grows a box by a margin on every side.
 *
 * @param {Object|null} box - the bounds
 * @param {Number} margin - millimetres
 * @returns {Object|null} the grown box
 */
export function padBounds(box, margin) {

	if (box === null || box === undefined)
		return null;

	return {
		minX: box.minX - margin,
		minY: box.minY - margin,
		maxX: box.maxX + margin,
		maxY: box.maxY + margin,
	};
}


/**
 * How wide and tall a box is.
 *
 * @param {Object|null} box - the bounds
 * @returns {Object} `{ width, height }` in millimetres; zeros for no box
 */
export function sizeOf(box) {

	if (box === null || box === undefined)
		return { width: 0, height: 0 };

	return { width: box.maxX - box.minX, height: box.maxY - box.minY };
}
