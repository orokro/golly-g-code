/**
 * @file defaultLayout.js
 * @description Where the windows sit when nothing has been saved.
 *
 * Frames are described in a hypothetical 1080p space and the manager scales
 * them; edges can reference another frame's edge with `["ref", "name.edge±n"]`,
 * which is what keeps the columns lined up at any window size instead of
 * drifting apart as percentages would.
 *
 * The arrangement is the one Greg specified: a narrow left column with the
 * Outliner above the Inspector, the main tab group taking the rest, and the
 * Timeline as a strip beneath it.
 */

import { FRAME_STYLE } from 'vue-win-mgr';

/** Width of the left column, in the layout's 1080p space. */
const LEFT_COLUMN = 380;

/** Height of the Timeline strip. */
const TIMELINE_HEIGHT = 220;

/**
 * Builds the default layout.
 *
 * A function rather than a constant because the manager mutates what it is
 * given, and a shared frozen constant handed to two managers — or to the same
 * one twice after a reset — is a bug that takes a while to see.
 *
 * @returns {Array<Object>} the layout
 */
export function defaultLayout() {

	return [
		{
			// the root, in hypothetical 1080p space
			name: 'window',
			top: 0,
			left: 0,
			bottom: 1080,
			right: 1920,
		},
		{
			name: 'Outliner',
			windows: ['outliner'],
			style: FRAME_STYLE.TABBED,
			left: 0,
			right: LEFT_COLUMN,
			top: 0,
			bottom: 420,
		},
		{
			name: 'Inspector',
			windows: ['inspector'],
			style: FRAME_STYLE.TABBED,
			left: 0,
			right: ['ref', 'Outliner.right'],
			top: ['ref', 'Outliner.bottom'],
			bottom: ['ref', 'window.bottom'],
		},
		{
			// the main tab group: everything you look at while working
			name: 'Main',
			windows: ['workspace', 'preview3d', 'preview2d', 'code', 'settings'],
			style: FRAME_STYLE.TABBED,
			left: ['ref', 'Outliner.right'],
			right: ['ref', 'window.right'],
			top: 0,
			bottom: ['ref', `window.bottom-${TIMELINE_HEIGHT}`],
		},
		{
			name: 'Timeline',
			windows: ['timeline'],
			style: FRAME_STYLE.TABBED,
			left: ['ref', 'Main.left'],
			right: ['ref', 'window.right'],
			top: ['ref', 'Main.bottom'],
			bottom: ['ref', 'window.bottom'],
		},
	];
}
