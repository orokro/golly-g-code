/**
 * @file useResize.js
 * @description Telling a view what size it actually is, safely.
 *
 * ## The zero
 *
 * A window hidden behind a tab in the window manager is `display: none`, and a
 * `display: none` element reports a size of 0×0. That number is real, arrives
 * through a perfectly ordinary ResizeObserver callback, and is poison:
 *
 * - `renderer.setSize(0, 0)` gives a canvas with no drawing buffer
 * - an aspect ratio of `0 / 0` is `NaN`
 * - a projection matrix built from `NaN` is entirely `NaN`
 * - every vertex it transforms becomes `NaN`, so the scene silently disappears
 *
 * And it does not come back when the tab is shown again, because nothing
 * recomputes the matrix — the size did not change, it was wrong once. The
 * symptom is a view that is blank forever after being hidden once, with no
 * error anywhere. So a zero is never passed on; it is simply not a size.
 *
 * ## The device pixel ratio
 *
 * A canvas has two sizes: the CSS box, and the drawing buffer behind it. Getting
 * them confused gives either a blurry view or a needlessly enormous one. The
 * buffer is the CSS size times the pixel ratio, and the ratio is CLAMPED —
 * rendering a 4K buffer on a 3× display costs nine times the fill rate of a 1×
 * one to be very slightly sharper, and this app has to stay usable on a 2017
 * MacBook.
 */

import { onMounted, onBeforeUnmount, unref } from 'vue';

/** Largest device pixel ratio worth honouring. */
export const MAX_PIXEL_RATIO = 2;


/**
 * Turns a measured box into the sizes a view needs, or null if it has none.
 *
 * Pure and exported so the rule can be tested directly, without a DOM, a
 * ResizeObserver or a component. The rule is the whole point of the module.
 *
 * @param {Number} width - CSS width, pixels
 * @param {Number} height - CSS height, pixels
 * @param {Object} [options] - options
 * @param {Number} [options.pixelRatio=1] - the display's ratio
 * @param {Number} [options.maxPixelRatio=MAX_PIXEL_RATIO] - the clamp
 * @returns {Object|null} `{ width, height, bufferWidth, bufferHeight, pixelRatio }`,
 *   or null when there is no usable size — which a caller must treat as "do
 *   nothing", never as "resize to nothing"
 */
export function resolveSize(width, height, options = {}) {

	const { pixelRatio = 1, maxPixelRatio = MAX_PIXEL_RATIO } = options;

	// A hidden element reports 0. NaN and Infinity arrive from arithmetic on a
	// layout that has not settled. None of them are sizes.
	if (!Number.isFinite(width) || !Number.isFinite(height))
		return null;

	const cssWidth = Math.floor(width);
	const cssHeight = Math.floor(height);

	if (cssWidth < 1 || cssHeight < 1)
		return null;

	const ratio = Math.min(
		Math.max(Number.isFinite(pixelRatio) ? pixelRatio : 1, 1),
		maxPixelRatio,
	);

	return {
		width: cssWidth,
		height: cssHeight,
		bufferWidth: Math.max(1, Math.round(cssWidth * ratio)),
		bufferHeight: Math.max(1, Math.round(cssHeight * ratio)),
		pixelRatio: ratio,
	};
}


/**
 * Watches an element and reports usable sizes.
 *
 * Framework-free, so it can be tested with a fake observer. `useResize` is the
 * Vue wrapper.
 *
 * @param {Function} onSize - called with the result of resolveSize when it changes
 * @param {Object} [options] - options
 * @param {Function} [options.observe] - constructs a ResizeObserver-alike
 * @param {Function} [options.getPixelRatio] - reads the display ratio
 * @param {Number} [options.maxPixelRatio=MAX_PIXEL_RATIO] - the clamp
 * @returns {Object} `{ attach, detach, measure, last }`
 */
export function createSizeWatcher(onSize, options = {}) {

	const {
		observe = (callback) => new ResizeObserver(callback),
		getPixelRatio = () => globalThis.devicePixelRatio ?? 1,
		maxPixelRatio = MAX_PIXEL_RATIO,
	} = options;

	let observer = null;
	let element = null;
	let last = null;

	/**
	 * Measures the element now and reports if anything changed.
	 *
	 * @returns {Object|null} the size, or null if there isn't one
	 */
	const measure = () => {

		if (element == null)
			return null;

		const box = element.getBoundingClientRect?.()
			?? { width: element.clientWidth, height: element.clientHeight };

		const size = resolveSize(box.width, box.height, {
			pixelRatio: getPixelRatio(),
			maxPixelRatio,
		});

		if (size === null)
			return null;

		// ResizeObserver fires for style changes that did not move anything, and
		// a Three.js resize reallocates buffers, so repeating one is not free
		if (last !== null
			&& last.bufferWidth === size.bufferWidth
			&& last.bufferHeight === size.bufferHeight)
			return last;

		last = size;
		onSize(size);
		return size;
	};

	return {

		/**
		 * Starts watching an element.
		 *
		 * @param {Object} target - the element
		 */
		attach(target) {

			if (target == null)
				return;

			element = target;
			observer = observe(() => measure());
			observer.observe(element);
			measure();
		},

		/** Stops watching, and forgets the last size. */
		detach() {
			observer?.disconnect();
			observer = null;
			element = null;
			last = null;
		},

		measure,

		/** @returns {Object|null} the last size reported */
		get last() {
			return last;
		},
	};
}


/**
 * Vue composable: watches a ref'd element and reports usable sizes.
 *
 * @param {Object} elementRef - a template ref
 * @param {Function} onSize - called with `{ width, height, bufferWidth, bufferHeight, pixelRatio }`
 * @param {Object} [options] - as createSizeWatcher
 * @returns {Object} the watcher, so a caller can `measure()` after being shown
 */
export function useResize(elementRef, onSize, options = {}) {

	const watcher = createSizeWatcher(onSize, options);

	onMounted(() => watcher.attach(unref(elementRef)));
	onBeforeUnmount(() => watcher.detach());

	return watcher;
}
