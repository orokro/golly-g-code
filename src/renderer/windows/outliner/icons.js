/**
 * @file icons.js
 * @description Which glyph stands for which kind of node.
 *
 * Material Icons, because `vue-settings-panel` already embeds the whole font in
 * its stylesheet — 2.4MB of it, which is a real cost and one already being paid
 * whether anything uses it or not. Adding a second icon set beside it would be
 * silly; the settings spec already names icons from it.
 */

import { NodeType } from '@core/project/nodes.js';

/** The glyph for each node type. */
export const NODE_ICON = Object.freeze({
	[NodeType.PROJECT]: 'inventory_2',
	[NodeType.FOLDER]: 'folder',
	[NodeType.TOOL]: 'hardware',
	[NodeType.JOB]: 'route',
	[NodeType.TAB]: 'content_cut',
	[NodeType.SVG_DOC]: 'description',
	[NodeType.SVG_PATH]: 'timeline',
	[NodeType.REFERENCE_IMAGE]: 'image',
	[NodeType.WORK_MATERIAL]: 'crop_square',
});

/**
 * The glyph for a node.
 *
 * @param {Object} node - the node
 * @returns {String} a Material Icons ligature name
 */
export function iconFor(node) {
	return NODE_ICON[node?.type] ?? 'help_outline';
}
