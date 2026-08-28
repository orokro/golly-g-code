/**
 * @file useRenderLoop.js
 * @description Registering a view with the app's render loop.
 *
 * The Vue half of `renderDriver.js`. It exists because the driver is
 * deliberately framework-free, and joining it to Vue's reactivity is exactly
 * where the interesting mistake lives.
 *
 * ## The mistake, which shipped and was caught by running it
 *
 * The driver stops requesting frames when nothing is visible — that is the point
 * of it. A view registers during `setup`, which happens BEFORE the window
 * manager has laid anything out, so at that moment every window reports itself
 * hidden. The driver looked, found nothing live, correctly declined to schedule
 * a frame, and then nothing ever asked it again. `wake()` existed for precisely
 * this and no caller invoked it.
 *
 * The result was an app where every frame counter sat at zero and
 * `requestAnimationFrame` was called exactly zero times, with no error and every
 * unit test passing — the driver's own tests covered waking it, because in a
 * test the wake is written by hand.
 *
 * So visibility is WATCHED here, and a view becoming visible wakes the loop.
 * Nothing that registers a render callback should have to remember that.
 */

import { watch, onBeforeUnmount, inject, unref } from 'vue';
import { useVisible } from './useVisible.js';

/**
 * Registers a render callback for the current window.
 *
 * @param {Function} render - called as (deltaSeconds, timestamp) while visible
 * @param {Object} [options] - options
 * @param {String} [options.label='view'] - named in error reports
 * @param {Object} [options.elementRef] - passed to useVisible for its fallback
 * @param {Object} [options.visible] - a ref, if the caller already has one
 * @param {Object} [options.driver] - injected by default
 * @returns {Object} `{ visible, stop }`
 */
export function useRenderLoop(render, options = {}) {

	const { label = 'view', elementRef = null } = options;

	const driver = options.driver !== undefined
		? options.driver
		: inject('renderDriver', null);

	const visible = options.visible ?? useVisible(elementRef).visible;

	if (driver == null) {
		// nothing to draw into; better to say so than to silently never render
		console.warn(`[render] '${label}' found no render driver to register with`);
		return { visible, stop: () => {} };
	}

	const stop = driver.add(render, {
		isVisible: () => unref(visible) !== false,
		label,
	});

	// The whole reason this file exists: the driver is asleep whenever nothing
	// is visible, and setup runs before anything is laid out. Becoming visible
	// has to wake it, or the loop never starts at all.
	const unwatch = watch(
		() => unref(visible),
		(nowVisible) => {
			if (nowVisible)
				driver.wake();
		},
		{ immediate: true },
	);

	onBeforeUnmount(() => {
		unwatch();
		stop();
	});

	return { visible, stop };
}
