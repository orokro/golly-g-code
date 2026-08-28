/**
 * @file useVisible.js
 * @description Whether a window is actually on screen.
 *
 * The render driver skips views that are not visible, which makes this the flag
 * the app's idle CPU cost hangs off. It comes from `windowCtx.isVisible`, which
 * exists because we asked for it upstream — so it is a capability of a
 * particular build of `vue-win-mgr`, not a guarantee of the API.
 *
 * ## Why there is a fallback at all
 *
 * If the context does not provide `isVisible`, the tempting default is `true`:
 * everything renders, nothing is broken, and the app is merely less efficient.
 * That is the wrong default, and quietly so — the whole point of the flag is to
 * stop hidden Three.js views burning a core, and "assume visible" restores
 * exactly the problem while looking fine. The failure has no symptom except a
 * warm laptop, which nobody reports as a bug.
 *
 * So when the flag is missing an IntersectionObserver watches the element
 * instead, which answers a slightly different question — is any of it within the
 * viewport — but answers it honestly. `source` says which is in use, so the
 * Settings window can show it rather than leaving it to be discovered.
 */

import { ref, computed, inject, onMounted, onBeforeUnmount, unref } from 'vue';

/** Where the visibility answer came from. */
export const VisibilitySource = Object.freeze({
	CONTEXT: 'windowCtx',
	OBSERVER: 'intersectionObserver',
	ASSUMED: 'assumed',
});


/**
 * Watches an element's intersection with the viewport.
 *
 * Framework-free so it can be tested with a fake observer.
 *
 * @param {Function} onChange - called with true or false
 * @param {Object} [options] - options
 * @param {Function} [options.observe] - constructs an IntersectionObserver-alike
 * @returns {Object} `{ attach, detach }`
 */
export function createVisibilityWatcher(onChange, options = {}) {

	const {
		observe = (callback) => new IntersectionObserver(callback, { threshold: 0 }),
	} = options;

	let observer = null;

	return {

		/**
		 * Starts watching an element.
		 *
		 * @param {Object} element - the element
		 * @returns {Boolean} true if it could attach
		 */
		attach(element) {

			if (element == null || typeof observe !== 'function')
				return false;

			observer = observe((entries) => {
				for (const entry of entries)
					onChange(entry.isIntersecting === true || entry.intersectionRatio > 0);
			});

			observer.observe(element);
			return true;
		},

		/** Stops watching. */
		detach() {
			observer?.disconnect();
			observer = null;
		},
	};
}


/**
 * Vue composable: is this window visible?
 *
 * @param {Object} [elementRef] - a template ref, used only for the fallback
 * @param {Object} [options] - options
 * @param {Object} [options.windowCtx] - injected by default
 * @param {Function} [options.observe] - as createVisibilityWatcher
 * @returns {Object} `{ visible, source }`, both reactive
 */
export function useVisible(elementRef = null, options = {}) {

	const windowCtx = options.windowCtx !== undefined
		? options.windowCtx
		: inject('windowCtx', null);

	// the good path: the window manager knows, because it owns the tabs
	if (windowCtx?.isVisible != null) {
		return {
			visible: computed(() => windowCtx.isVisible.value !== false),
			source: ref(VisibilitySource.CONTEXT),
		};
	}

	const visible = ref(true);
	const source = ref(VisibilitySource.ASSUMED);
	const watcher = createVisibilityWatcher((value) => { visible.value = value; }, options);

	onMounted(() => {
		if (watcher.attach(unref(elementRef)))
			source.value = VisibilitySource.OBSERVER;
	});

	onBeforeUnmount(() => watcher.detach());

	return { visible, source };
}
