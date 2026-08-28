/**
 * @file renderDriver.js
 * @description One requestAnimationFrame loop for the whole application.
 *
 * ## Why one, and why it has to know about visibility
 *
 * Every live view — the 2D workspace, the 3D preview, the timeline scrubber —
 * wants a frame callback. The obvious thing is for each to call
 * `requestAnimationFrame` itself, and it is wrong here for a reason specific to
 * this app.
 *
 * A hidden browser TAB gets throttled to roughly one frame a second by the
 * browser. A window hidden behind another tab **inside** the window manager does
 * not: as far as the browser is concerned the page is fully visible, so a Three.js
 * view sitting in a background tab of the frame keeps rendering at 60fps into a
 * canvas nobody can see. With several such views that is most of a CPU core spent
 * on nothing, and on Greg's 2017 MacBook driving the router that is not free.
 *
 * So the driver asks each registered view whether it is visible before calling
 * it, and — the part that actually matters — **stops requesting frames entirely**
 * when none are. An idle app should schedule no work at all, not schedule work
 * that does nothing.
 *
 * ## Deliberately not a Vue module
 *
 * No `ref`, no `onMounted`, no component instance. The loop is a plain object so
 * its behaviour can be tested by driving it with a fake clock and a fake
 * `requestAnimationFrame`, rather than by mounting components and hoping. The Vue
 * side is a thin composable on top (`useRenderLoop`).
 */

/**
 * Creates a render driver.
 *
 * @param {Object} [options] - options
 * @param {Function} [options.requestFrame=requestAnimationFrame] - schedules a frame
 * @param {Function} [options.cancelFrame=cancelAnimationFrame] - cancels a scheduled frame
 * @param {Function} [options.onError] - called with (error, label) when a
 *   callback throws; by default it is reported and the offender is dropped
 * @returns {Object} the driver
 */
export function createRenderDriver(options = {}) {

	const {
		requestFrame = (fn) => requestAnimationFrame(fn),
		cancelFrame = (id) => cancelAnimationFrame(id),
		onError = (error, label) => console.error(`[render] '${label}' threw, dropping it`, error),
	} = options;

	/** @type {Set<Object>} registered views */
	const views = new Set();

	let handle = null;
	let last = null;

	/**
	 * Are any registered views actually asking for frames right now?
	 *
	 * @returns {Boolean} true if at least one is visible
	 */
	const anyLive = () => {
		for (const view of views)
			if (view.isVisible() !== false)
				return true;
		return false;
	};

	/**
	 * Runs one frame, then schedules the next only if there is still work.
	 *
	 * @param {Number} timestamp - as given to a frame callback, milliseconds
	 */
	const frame = (timestamp) => {

		handle = null;

		// First frame after idling has no meaningful delta. Handing a view the
		// wall-clock gap since it was last visible would make an animation jump
		// by however long the tab was hidden.
		const delta = last === null ? 0 : Math.max(0, (timestamp - last) / 1000);
		last = timestamp;

		for (const view of [...views]) {

			if (view.isVisible() === false)
				continue;

			try {
				view.render(delta, timestamp);
			} catch (error) {
				// one broken view must not stop every other view rendering
				views.delete(view);
				onError(error, view.label);
			}
		}

		schedule();
	};

	/** Requests a frame if one is wanted and none is pending. */
	const schedule = () => {

		if (handle !== null)
			return;

		if (!anyLive()) {
			// nothing to draw: stop asking. `last` is cleared so the frame after
			// waking up starts a fresh delta rather than a huge one
			last = null;
			return;
		}

		handle = requestFrame(frame);
	};

	return {

		/**
		 * Registers a view.
		 *
		 * @param {Function} render - called as (deltaSeconds, timestamp)
		 * @param {Object} [config] - config
		 * @param {Function} [config.isVisible] - returns false to be skipped
		 * @param {String} [config.label='view'] - named in error reports
		 * @returns {Function} call to unregister
		 */
		add(render, config = {}) {

			const view = {
				render,
				isVisible: config.isVisible ?? (() => true),
				label: config.label ?? 'view',
			};

			views.add(view);
			schedule();

			return () => {
				views.delete(view);
				if (!anyLive() && handle !== null) {
					cancelFrame(handle);
					handle = null;
					last = null;
				}
			};
		},

		/**
		 * Asks for a frame. Call after making something visible, since the loop
		 * stops when nothing is.
		 */
		wake: schedule,

		/** Stops the loop and forgets every view. */
		stop() {
			if (handle !== null)
				cancelFrame(handle);
			handle = null;
			last = null;
			views.clear();
		},

		/** @returns {Object} counts, for tests and the status bar */
		get state() {
			let live = 0;
			for (const view of views)
				if (view.isVisible() !== false)
					live++;
			return { registered: views.size, live, running: handle !== null };
		},
	};
}
