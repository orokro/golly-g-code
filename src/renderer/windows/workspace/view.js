/**
 * @file view.js
 * @description Pan, zoom, and the one place Y stops pointing up.
 *
 * ---------------------------------------------------------------------------
 * The Y flip lives HERE and nowhere else
 *
 * The core is +Y up, matching the machine (CONVENTIONS.md rule 3). SVG is +Y
 * down. Something has to flip, and jscut is the cautionary tale for letting it
 * happen late: it deferred the flip all the way to a `-p.Y * scale` inside the
 * G-code emitter, which left every intermediate stage reasoning in a different
 * coordinate system than its output.
 *
 * So the flip is a `scale(1, -1)` inside this transform, applied to the whole
 * scene at once. Every number on either side of it is honest: world coordinates
 * are millimetres with Y up, screen coordinates are pixels with Y down, and
 * nothing in between is half-converted.
 * ---------------------------------------------------------------------------
 *
 * A view is three numbers and no state: the scale, and where the world origin
 * lands on screen. Pan and zoom return a new view rather than mutating one,
 * which is what lets a `shallowRef` hold it (renderer/CONVENTIONS.md) and what
 * makes every function here testable without a DOM.
 */

/** How far out you can zoom: the whole 400mm bed in a hundred pixels. */
export const MIN_SCALE = 0.05;

/** How far in: a tenth of a millimetre filling the view. */
export const MAX_SCALE = 400;

/** Fraction of the viewport left empty around a zoom-to-fit. */
export const FIT_MARGIN = 0.06;


/**
 * @typedef {Object} View
 * @property {Number} scale - pixels per millimetre
 * @property {Number} x - screen x of the world origin
 * @property {Number} y - screen y of the world origin
 */


/**
 * A view showing nothing in particular.
 *
 * @returns {View} the identity view, one pixel per millimetre at the top left
 */
export function createView() {
	return { scale: 1, x: 0, y: 0 };
}


/**
 * The SVG transform for a view.
 *
 * Read right to left: flip Y so up is up, scale into pixels, then move the
 * origin to where it belongs on screen.
 *
 * @param {View} view - the view
 * @returns {String} a `transform` attribute
 */
export function viewTransform(view) {
	return `translate(${view.x} ${view.y}) scale(${view.scale} ${-view.scale})`;
}


/**
 * Where a world point lands on screen.
 *
 * @param {View} view - the view
 * @param {Number} x - millimetres
 * @param {Number} y - millimetres, up
 * @returns {Object} `{ x, y }` in pixels, down
 */
export function toScreen(view, x, y) {
	return { x: view.x + (x * view.scale), y: view.y - (y * view.scale) };
}


/**
 * Where a screen point is in the world.
 *
 * @param {View} view - the view
 * @param {Number} x - pixels
 * @param {Number} y - pixels, down
 * @returns {Object} `{ x, y }` in millimetres, up
 */
export function toWorld(view, x, y) {
	return { x: (x - view.x) / view.scale, y: (view.y - y) / view.scale };
}


/**
 * Moves the view by a screen distance.
 *
 * @param {View} view - the view
 * @param {Number} dx - pixels
 * @param {Number} dy - pixels
 * @returns {View} a new view
 */
export function panBy(view, dx, dy) {
	return { scale: view.scale, x: view.x + dx, y: view.y + dy };
}


/**
 * Zooms about a fixed screen point.
 *
 * The point under the cursor stays under the cursor, which is the only zoom
 * behaviour that feels like anything other than a fight. Achieved by converting
 * that point to the world before scaling and putting it back afterwards.
 *
 * @param {View} view - the view
 * @param {Number} factor - multiplier, above 1 to zoom in
 * @param {Number} screenX - the fixed point, pixels
 * @param {Number} screenY - the fixed point, pixels
 * @returns {View} a new view
 */
export function zoomAt(view, factor, screenX, screenY) {

	const scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
	const world = toWorld(view, screenX, screenY);

	return {
		scale,
		x: screenX - (world.x * scale),
		y: screenY + (world.y * scale),
	};
}


/**
 * A view that fits a world rectangle into a viewport.
 *
 * @param {Object|null} bounds - `{ minX, minY, maxX, maxY }` in millimetres
 * @param {Object} size - `{ width, height }` in pixels
 * @param {Object} [options] - options
 * @param {Number} [options.margin=FIT_MARGIN] - fraction of the viewport left empty
 * @returns {View} a new view, or the identity when there is nothing to fit
 */
export function fitBounds(bounds, size, options = {}) {

	const { margin = FIT_MARGIN } = options;

	if (bounds === null || bounds === undefined || !(size.width > 0) || !(size.height > 0))
		return createView();

	const width = Math.max(bounds.maxX - bounds.minX, 1e-6);
	const height = Math.max(bounds.maxY - bounds.minY, 1e-6);

	const usable = 1 - (margin * 2);
	const scale = clamp(
		Math.min((size.width * usable) / width, (size.height * usable) / height),
		MIN_SCALE, MAX_SCALE);

	// put the middle of the box in the middle of the viewport
	const midX = (bounds.minX + bounds.maxX) / 2;
	const midY = (bounds.minY + bounds.maxY) / 2;

	return {
		scale,
		x: (size.width / 2) - (midX * scale),
		y: (size.height / 2) + (midY * scale),
	};
}


/**
 * A sensible spacing for the minor grid at the current zoom.
 *
 * A fixed 10mm grid is a solid wall of lines when zoomed out to the whole bed
 * and a single line when zoomed into a corner. This walks the 1-2-5 sequence
 * until a cell is at least `minPixels` across, which is what every CAD package
 * does and what makes the grid read as a ruler rather than as decoration.
 *
 * @param {Number} scale - pixels per millimetre
 * @param {Number} [minPixels=8] - smallest cell worth drawing
 * @returns {Number} spacing in millimetres
 */
export function gridSpacing(scale, minPixels = 8) {

	if (!(scale > 0))
		return 10;

	const steps = [1, 2, 5];
	let power = -3;

	for (let i = 0; i < 60; i += 1) {

		const spacing = steps[i % 3] * (10 ** (power + Math.floor(i / 3)));

		if (spacing * scale >= minPixels)
			return spacing;
	}

	return 1000;
}


/**
 * Keeps a number inside a range.
 *
 * @param {Number} value - the number
 * @param {Number} low - the floor
 * @param {Number} high - the ceiling
 * @returns {Number} the clamped number
 */
function clamp(value, low, high) {
	return Math.min(Math.max(value, low), high);
}
