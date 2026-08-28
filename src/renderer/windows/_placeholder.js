/**
 * @file _placeholder.js
 * @description Shared innards for the Phase 2 stand-in windows.
 *
 * Phase 2's goal is the shell, with dummy window contents. But "dummy" here does
 * one real job: each stand-in registers with the app's render driver and counts
 * the frames it is given, and reports its own visibility and measured size.
 *
 * That turns the three pieces this phase is really about — `useVisible`,
 * `useResize` and the render driver — into something observable. A hidden window
 * whose frame count keeps climbing is the exact bug the driver exists to
 * prevent, and it has no other symptom than a warm laptop. Here you can watch it
 * stop.
 */

import { ref, computed } from 'vue';
import { useResize } from '../composables/useResize.js';
import { useRenderLoop } from '../composables/useRenderLoop.js';
import { useWindowState } from '../composables/useWindowState.js';

/**
 * Wires a placeholder up to the shell.
 *
 * @param {String} title - what to show
 * @param {Object} bodyRef - a template ref on the window's root element
 * @returns {Object} bindings for the template
 */
export function usePlaceholder(title, bodyRef) {

	// Per-window state that rides along with the saved layout. A counter here
	// stands in for the Workspace's zoom or the 3D view's camera: click it, save
	// the layout, reload, and it should still be what you left it at.
	const state = useWindowState({ visits: 0 });
	state.visits++;

	/** How many frames the driver has actually handed this window. */
	const frames = ref(0);

	/** The last usable size, or null while hidden. */
	const size = ref(null);

	useResize(bodyRef, (measured) => { size.value = measured; });

	// One loop for the whole app, provided by App.vue. It skips this callback
	// entirely while the window is hidden, which is what the frame count makes
	// visible -- a hidden window whose count keeps climbing is the bug.
	const { visible } = useRenderLoop(() => { frames.value++; },
		{ label: title, elementRef: bodyRef });

	return {
		title,
		visible,
		state,
		source: 'windowCtx',
		frames,
		size,
		sizeLabel: computed(() => (size.value === null
			? 'no usable size (hidden)'
			: `${size.value.width}×${size.value.height} css, `
				+ `${size.value.bufferWidth}×${size.value.bufferHeight} buffer `
				+ `@${size.value.pixelRatio}×`)),
	};
}
