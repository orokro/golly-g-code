/**
 * @file registry.js
 * @description Every window the app can open, and the slug each is known by.
 *
 * ## Why every slug is written out
 *
 * `vue-win-mgr` will derive a slug from a component if you do not supply one, by
 * reading its name. That is fine in development and a trap in a packaged build:
 * the name comes from the build, minification renames it, and a saved layout
 * written before a release stops matching the windows in the release. The user
 * opens the app to a layout that silently drops half its panels, and nothing
 * anywhere says why.
 *
 * So the slug is the identifier, it is written here, and it is permanent. A
 * slug may never change once a build has shipped with it — rename the title
 * instead, which is what people actually read.
 */

import Outliner from './OutlinerWindow.vue';
import Inspector from './InspectorWindow.vue';
import Workspace from './WorkspaceWindow.vue';
import Preview3D from './Preview3DWindow.vue';
import Preview2D from './Preview2DWindow.vue';
import CodeEditor from './CodeEditorWindow.vue';
import Timeline from './TimelineWindow.vue';
import Settings from './SettingsWindow.vue';

/**
 * The window list, in the order they appear in the "add window" menu.
 *
 * @type {Array<Object>}
 */
export const availableWindows = Object.freeze([
	{ window: Outliner, slug: 'outliner', title: 'Outliner' },
	{ window: Inspector, slug: 'inspector', title: 'Inspector' },
	{ window: Workspace, slug: 'workspace', title: 'Workspace' },
	{ window: Preview3D, slug: 'preview3d', title: 'Preview 3D' },
	{ window: Preview2D, slug: 'preview2d', title: 'Preview 2D' },
	{ window: CodeEditor, slug: 'code', title: 'G-code' },
	{ window: Timeline, slug: 'timeline', title: 'Timeline' },
	{ window: Settings, slug: 'settings', title: 'Settings' },
]);

/**
 * Just the slugs, for validating a stored layout against this build.
 *
 * @type {Array<String>}
 */
export const windowSlugs = Object.freeze(availableWindows.map((entry) => entry.slug));
