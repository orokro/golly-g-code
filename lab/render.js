/**
 * @file render.js
 * @description Renders core geometry to an SVG string, for eyeballing.
 *
 * The CAM core is headless and covered by tests, but a passing assertion about
 * a point count tells you nothing about whether a toolpath looks right. This
 * draws what the core actually produced so a human can look at it.
 *
 * Pure string building, no DOM — so the same code renders a live page in the
 * browser and a static report from a Node script.
 */

/** Colours chosen to stay legible against a dark background. */
export const PALETTE = Object.freeze({
	background: '#16161a',
	grid: '#26262e',
	gridMajor: '#33333d',
	source: '#5ec8d8',
	sourceOpen: '#ffb347',
	outward: '#7ee081',
	inward: '#e0798f',
	vertex: '#ffffff',
	text: '#8a8a95',
});


/**
 * Computes the bounding box of a set of polylines.
 *
 * @param {Array<Array<Number[]>>} polylines - point arrays
 * @returns {Object} `{ minX, minY, maxX, maxY }`
 */
export function bounds(polylines) {

	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

	for (const line of polylines) {
		for (const [x, y] of line) {
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}

	return { minX, minY, maxX, maxY };
}


/**
 * Converts a polyline to SVG path data.
 *
 * @param {Array<Number[]>} points - the points
 * @param {Boolean} closed - whether to close the path
 * @returns {String} path data
 */
export function toPathData(points, closed) {

	if (points.length === 0)
		return '';

	const head = `M${points[0][0].toFixed(3)} ${points[0][1].toFixed(3)}`;
	const tail = points.slice(1).map(([x, y]) => `L${x.toFixed(3)} ${y.toFixed(3)}`).join('');

	return head + tail + (closed ? 'Z' : '');
}


/**
 * Builds a millimetre grid covering a box.
 *
 * @param {Object} box - `{ minX, minY, maxX, maxY }` in millimetres
 * @param {Number} step - minor grid spacing in millimetres
 * @returns {String} SVG markup
 */
function gridMarkup(box, step) {

	const lines = [];
	const major = step * 10;

	const startX = Math.floor(box.minX / step) * step;
	const startY = Math.floor(box.minY / step) * step;

	for (let x = startX; x <= box.maxX; x += step) {
		const isMajor = Math.abs(x % major) < step / 2;
		lines.push(`<line x1="${x}" y1="${box.minY}" x2="${x}" y2="${box.maxY}" stroke="${
			isMajor ? PALETTE.gridMajor : PALETTE.grid}" stroke-width="${isMajor ? 0.35 : 0.15}"/>`);
	}

	for (let y = startY; y <= box.maxY; y += step) {
		const isMajor = Math.abs(y % major) < step / 2;
		lines.push(`<line x1="${box.minX}" y1="${y}" x2="${box.maxX}" y2="${y}" stroke="${
			isMajor ? PALETTE.gridMajor : PALETTE.grid}" stroke-width="${isMajor ? 0.35 : 0.15}"/>`);
	}

	return lines.join('');
}


/**
 * Renders a pipeline result as a standalone SVG string.
 *
 * The y axis is flipped back for display only — the core works y-up, but SVG
 * draws y-down, so the whole scene is mirrored at render time rather than the
 * geometry being stored upside down.
 *
 * @param {Object} scene - what to draw
 * @param {Array<Object>} scene.source - `{ points, closed }` per flattened subpath
 * @param {Array<Array<Number[]>>} [scene.outward] - outward offset polygons
 * @param {Array<Array<Number[]>>} [scene.inward] - inward offset polygons
 * @param {Object} [options] - options
 * @param {Number} [options.padding=5] - margin in millimetres
 * @param {Boolean} [options.showVertices=false] - dot every flattened point
 * @param {Number} [options.gridStep=10] - minor grid spacing in millimetres
 * @returns {String} an `<svg>` element
 */
export function renderSceneSvg(scene, options = {}) {

	const { padding = 5, showVertices = false, gridStep = 10 } = options;

	const all = [
		...scene.source.map((s) => s.points),
		...(scene.outward ?? []),
		...(scene.inward ?? []),
	].filter((p) => p.length > 0);

	if (all.length === 0)
		return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"></svg>';

	const box = bounds(all);
	const view = {
		minX: box.minX - padding,
		minY: box.minY - padding,
		maxX: box.maxX + padding,
		maxY: box.maxY + padding,
	};

	const width = view.maxX - view.minX;
	const height = view.maxY - view.minY;

	// stroke widths are in millimetres, so scale them to stay visible at any size
	const hair = Math.max(width, height) / 900;

	const parts = [];

	parts.push(gridMarkup(view, gridStep));

	for (const polygon of scene.outward ?? [])
		parts.push(`<path d="${toPathData(polygon, true)}" fill="none" stroke="${PALETTE.outward}" stroke-width="${hair * 1.6}"/>`);

	for (const polygon of scene.inward ?? [])
		parts.push(`<path d="${toPathData(polygon, true)}" fill="none" stroke="${PALETTE.inward}" stroke-width="${hair * 1.6}"/>`);

	for (const sub of scene.source) {
		// open subpaths get their own colour: this is the distinction jscut loses
		const colour = sub.closed ? PALETTE.source : PALETTE.sourceOpen;
		const dash = sub.closed ? '' : ` stroke-dasharray="${hair * 6} ${hair * 4}"`;
		parts.push(`<path d="${toPathData(sub.points, sub.closed)}" fill="none" stroke="${colour}" stroke-width="${hair * 2.2}"${dash}/>`);
	}

	if (showVertices === true) {
		for (const sub of scene.source)
			for (const [x, y] of sub.points)
				parts.push(`<circle cx="${x.toFixed(3)}" cy="${y.toFixed(3)}" r="${hair * 1.8}" fill="${PALETTE.vertex}" opacity="0.55"/>`);
	}

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.minX} ${view.minY} ${width} ${height}"`,
		` style="background:${PALETTE.background};width:100%;height:auto">`,
		// one flip for the whole scene, so nothing downstream stores y-down
		`<g transform="translate(0 ${view.minY + view.maxY}) scale(1 -1)">`,
		parts.join(''),
		'</g></svg>',
	].join('');
}
