/**
 * @file spec.js
 * @description What lives in the Settings window, and what it defaults to.
 *
 * Data, not components — the panel is driven entirely by this. Keeping it apart
 * from the window means the defaults can be asserted, and the settings tiering
 * (D-settings: document vs application) has one place to be argued about.
 *
 * Only APPLICATION settings belong here: things true of this installation
 * regardless of what is open. Anything that belongs to a piece of work — stock
 * thickness, work zero, feeds — is document state and lives in the project file,
 * because carrying it between projects is how you cut a 4mm job at 18mm depths.
 */

import { TYPES } from 'vue-settings-panel';

/** Categories down the left of the panel. */
const categories = [
	{ name: 'General', slug: 'general', icon: 'settings' },
	{ name: 'Display', slug: 'display', icon: 'palette' },
	{ name: 'Output', slug: 'output', icon: 'code' },
];

/**
 * The specification the panel renders.
 *
 * @type {Object}
 */
export const settingsSpec = Object.freeze({

	categories,

	settings: {

		units: {
			name: 'Display units',
			desc: 'How lengths are shown. Geometry is always millimetres internally;'
				+ ' this changes presentation only.',
			cats: ['general'],
			type: TYPES.Select,
			default: 'mm',
			// a plain array of primitives -- the value IS the option. An earlier
			// version passed {label, value} objects, which the panel rendered
			// literally as `{ "label": "Millimetres", "value": "mm" }`
			opts: { options: ['mm', 'inch'] },
		},

		theme: {
			name: 'Theme',
			desc: 'Dark suits a workshop; light suits a bright room.',
			cats: ['display'],
			type: TYPES.Select,
			default: 'dark',
			opts: { options: ['dark', 'light'] },
		},

		showGrid: {
			name: 'Show grid',
			desc: 'A grid in the Workspace, in real units. jscut has none, which makes'
				+ ' judging a size by eye impossible.',
			cats: ['display'],
			type: TYPES.Boolean,
			default: true,
		},

		showTravel: {
			name: 'Show travel moves',
			desc: 'The rapids between cuts — the lifts and crossings the machine makes'
				+ ' getting from one cut to the next. The only way to SEE what the'
				+ ' cutting order costs you rather than argue about it. Turn it off'
				+ ' when it clutters.',
			cats: ['display'],
			type: TYPES.Boolean,
			default: true,
		},

		showTabs: {
			name: 'Show holding tabs',
			desc: 'The bridges of material left uncut so a part does not come loose.',
			cats: ['display'],
			type: TYPES.Boolean,
			default: true,
		},

		gridSpacing: {
			name: 'Grid spacing (mm)',
			desc: 'Distance between minor grid lines.',
			cats: ['display'],
			type: TYPES.Number,
			default: 10,
			opts: { min: 0.1, max: 100, step: 0.1 },
		},

		decimals: {
			name: 'G-code decimal places',
			desc: 'jscut hard-codes four. At 0.0001mm that is far finer than a hobby'
				+ ' router resolves, and only makes the file bigger.',
			cats: ['output'],
			type: TYPES.Number,
			default: 3,
			opts: { min: 1, max: 6, step: 1 },
		},

		arcFitting: {
			name: 'Fit arcs (G2/G3)',
			desc: 'Refit curves as real arcs instead of thousands of tiny straight'
				+ ' moves. Smoother motion, and a far smaller file.',
			cats: ['output'],
			type: TYPES.Boolean,
			default: true,
		},

		arcTolerance: {
			name: 'Arc tolerance (mm)',
			desc: 'How far a fitted arc may stray from the toolpath. Tighter means'
				+ ' more blocks.',
			cats: ['output'],
			type: TYPES.Number,
			default: 0.01,
			opts: { min: 0.001, max: 0.1, step: 0.001 },
		},
	},
});
