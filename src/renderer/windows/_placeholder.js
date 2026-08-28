/**
 * @file _placeholder.js
 * @description Shared innards for the Phase 2 stand-in windows.
 *
 * Phase 2's goal is the shell: the layout, the theme, persistence and the render
 * driver, with dummy window contents. These stand-ins exist so the shell can be
 * exercised — dragged, split, tabbed, saved, reloaded — before any of the real
 * views exist.
 *
 * Each one shows what it is and whether the window manager currently considers
 * it visible, because that flag is what the render driver keys off and a bug in
 * it would otherwise only show up later as a mysteriously warm laptop.
 */

import { inject, computed } from 'vue';

/**
 * Wires a placeholder up to its window context.
 *
 * @param {String} title - what to show
 * @returns {Object} `{ title, visible }` for the template
 */
export function usePlaceholder(title) {

	const windowCtx = inject('windowCtx', null);

	return {
		title,
		visible: computed(() => windowCtx?.isVisible?.value ?? true),
	};
}
