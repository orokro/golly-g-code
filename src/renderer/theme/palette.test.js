import { describe, it, expect } from 'vitest';
import { presets, dark, light, windowManagerTheme, settingsPanelTheme, cssVariables, applyPalette } from './palette.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const ROLES = Object.keys(dark).filter((k) => k !== 'name' && k !== 'dark');


describe('presets', () => {

	it('define every role, in every preset', () => {
		// a missing role is a component silently falling back to a browser
		// default, which looks like a styling bug somewhere else entirely
		for (const [name, palette] of Object.entries(presets))
			for (const role of ROLES)
				expect(palette[role], `${name}.${role}`).toMatch(/^#[0-9a-f]{6}$/i);
	});

	it('say which of them are dark', () => {
		expect(dark.dark).toBe(true);
		expect(light.dark).toBe(false);
	});

	it('put text and background far enough apart to read', () => {
		// crude luminance, but enough to catch a preset where a role was pasted
		// into the wrong slot — the failure mode that produces grey-on-grey
		const luminance = (hex) => {
			const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
			return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
		};
		for (const [name, palette] of Object.entries(presets)) {
			expect(Math.abs(luminance(palette.text) - luminance(palette.surface)), `${name} body`)
				.toBeGreaterThan(0.4);
			expect(Math.abs(luminance(palette.accentText) - luminance(palette.accent)), `${name} accent`)
				.toBeGreaterThan(0.25);
		}
	});
});


describe('deriving the window manager theme', () => {

	it('maps every key it sets to a colour from the palette', () => {
		const theme = windowManagerTheme(dark);
		const known = new Set(ROLES.map((role) => dark[role]));
		for (const [key, value] of Object.entries(theme))
			expect(known.has(value), `${key} = ${value}`).toBe(true);
	});

	it('changes with the preset rather than being hard-coded', () => {
		expect(windowManagerTheme(dark)).not.toEqual(windowManagerTheme(light));
		expect(windowManagerTheme(light).systemBGColor).toBe(light.background);
	});
});


describe('CSS variables', () => {

	it('are all ours, and all prefixed', () => {
		for (const name of Object.keys(cssVariables(dark)))
			expect(name, name).toMatch(/^--gg-/);
	});

	it('never leaves a variable undefined', () => {
		for (const palette of Object.values(presets))
			for (const [name, value] of Object.entries(cssVariables(palette)))
				expect(value, `${palette.name} ${name}`).toBeTruthy();
	});

	it('agree with the settings panel about the same surfaces', () => {
		// The drift this module exists to prevent. SettingsWindow.vue patches a
		// few colours the panel hard-codes, using OUR variables, right next to
		// regions the panel paints from its own -- so the two derivations meet
		// on screen, pixel against pixel, and any disagreement shows there.
		//
		// Both sides of this are ours, so it proves consistency and not
		// correctness. The tests below check correctness against the library.
		const vars = cssVariables(light);
		const panel = settingsPanelTheme(light);
		expect(panel.mainColumn.categoryBgColor).toBe(vars['--gg-surface-raised']);
		expect(panel.mainColumn.subcategoryBgColor).toBe(vars['--gg-surface-sunken']);
		expect(panel.leftColumn.selectedCategoryTextColor).toBe(vars['--gg-accent-text']);
	});
});


describe('applying a palette', () => {

	/** The smallest thing that behaves like an element for this purpose. */
	const fakeElement = () => ({
		dataset: {},
		style: {
			values: {},
			setProperty(name, value) { this.values[name] = value; },
		},
	});

	it('writes every variable and records which preset is on', () => {
		const element = fakeElement();
		applyPalette(light, element);

		expect(element.dataset.theme).toBe('light');
		expect(element.style.values['--gg-surface']).toBe(light.surface);
		expect(Object.keys(element.style.values)).toHaveLength(
			Object.keys(cssVariables(light)).length);
	});

	it('replaces the previous preset completely when switching', () => {
		const element = fakeElement();
		applyPalette(dark, element);
		applyPalette(light, element);

		for (const [name, value] of Object.entries(cssVariables(light)))
			expect(element.style.values[name], name).toBe(value);
	});

	it('does nothing rather than throwing when there is no document', () => {
		expect(() => applyPalette(dark, null)).not.toThrow();
	});
});


describe('the settings panel theme', () => {

	// This is a NESTED OBJECT the library takes as a prop, not CSS variables we
	// set. An earlier version of palette.js invented `--lc-*` and `--mc-*`
	// variable names from a description of the library and tested that they
	// agreed with our own — which they did, and proved nothing, because the
	// library never reads them.
	//
	// The version after that read the real key names and mapped them by what
	// they sound like, which is the same mistake in better clothes:
	// `categoryHeaderColor` is a TEXT colour, so the category title came out as
	// #1d1d23 on #16161a and could not be read at all.
	//
	// So the tests below go to the library's shipped stylesheet — the only thing
	// that decides what a key means — and check three separate claims: that we
	// set every variable it reads, that the keys we treat as text really are
	// used as text, and that each of those is legible on what sits behind it.

	it('fills every group the library defines, and nothing else', async () => {
		const { defaultTheme } = await import('vue-settings-panel');
		const ours = settingsPanelTheme(dark);

		expect(Object.keys(ours).sort()).toEqual(Object.keys(defaultTheme).sort());

		for (const [group, fields] of Object.entries(defaultTheme))
			expect(Object.keys(ours[group]).sort(), group).toEqual(Object.keys(fields).sort());
	});

	it('leaves no field undefined, in either preset', () => {
		for (const palette of Object.values(presets))
			for (const [group, fields] of Object.entries(settingsPanelTheme(palette)))
				for (const [key, value] of Object.entries(fields))
					expect(value, `${palette.name}.${group}.${key}`).toBeTruthy();
	});

	it('changes with the preset', () => {
		expect(settingsPanelTheme(dark)).not.toEqual(settingsPanelTheme(light));
	});

	it('sets every variable the library stylesheet reads', () => {
		// A variable the stylesheet reads and we never set falls back to the
		// library's own default, which is a LIGHT theme. One missing key is one
		// stripe of white in an otherwise dark panel, and nothing errors.
		const read = variablesReadBy(stylesheet());
		const set = new Set(Object.keys(flattenTheme(settingsPanelTheme(dark))));

		// a subset assertion is vacuously true against an empty set, and this
		// test was exactly that for one run -- see `stylesheet` below
		expect(read.size).toBeGreaterThan(8);
		expect(read).toContain('--mc-categoryHeaderColor');

		const missing = [...read].filter((name) => !set.has(name));
		expect(missing, 'read by the stylesheet, never set by us').toEqual([]);
	});

	it('agrees with the stylesheet about which fields are text colours', () => {
		// Keeps the pairings below honest. If a future version of the library
		// turns one of these into a background, the contrast test underneath is
		// suddenly checking the wrong two colours against each other and would
		// go on passing.
		const asText = propertiesUsing(stylesheet());

		for (const { colour } of LEGIBLE)
			expect(asText.get(variableName(colour)), colour).toContain('color');
	});

	it('keeps every text colour legible on what is behind it, in both presets', () => {
		for (const palette of Object.values(presets)) {
			const theme = settingsPanelTheme(palette);
			for (const { colour, behind } of LEGIBLE) {
				const ratio = contrast(at(theme, palette, colour), at(theme, palette, behind));
				expect(ratio, `${palette.name}: ${colour} on ${behind} (${ratio.toFixed(2)}:1)`)
					.toBeGreaterThanOrEqual(4.5);
			}
		}
	});
});


/**
 * Every text colour the panel draws, and the surface it is drawn on.
 *
 * The surfaces come from reading the library's stylesheet: a category title
 * sits inside `.category-box`, whose background is `categoryBgColor`, and a
 * setting's name sits inside `.subcategory-box`. `left.categoryColor` is the
 * exception — the stylesheet gives the left column no background at all, so
 * SettingsWindow.vue paints it `--gg-surface-raised` and that is what is behind.
 */
const LEGIBLE = [
	{ colour: 'main.categoryHeaderColor', behind: 'main.categoryBgColor' },
	{ colour: 'main.categoryTextColor', behind: 'main.categoryBgColor' },
	{ colour: 'main.subcategoryHeaderColor', behind: 'main.subcategoryBgColor' },

	// a setting sits in its subcategory's box when it has one, and straight on
	// the category's when it does not -- today's spec has no subcategories, so
	// only the second of each pair is on screen. Both are, sooner or later.
	{ colour: 'main.settingsRowNameColor', behind: 'main.subcategoryBgColor' },
	{ colour: 'main.settingsRowNameColor', behind: 'main.categoryBgColor' },
	{ colour: 'main.settingsRowDescColor', behind: 'main.subcategoryBgColor' },
	{ colour: 'main.settingsRowDescColor', behind: 'main.categoryBgColor' },
	{ colour: 'left.searchTextColor', behind: 'left.searchBgColor' },
	{ colour: 'left.selectedCategoryTextColor', behind: 'left.selectedCategoryBgColor' },
	{ colour: 'left.categoryColor', behind: 'palette.surfaceRaised' },
];

/**
 * Resolves a `LEGIBLE` reference to a colour.
 *
 * @param {Object} theme - the result of `settingsPanelTheme`
 * @param {Object} palette - the palette it came from
 * @param {String} reference - `main.x`, `left.x`, or `palette.role`
 * @returns {String} a hex colour
 */
function at(theme, palette, reference) {

	const [group, key] = reference.split('.');

	if (group === 'palette')
		return palette[key];

	return group === 'main' ? theme.mainColumn[key] : theme.leftColumn[key];
}

/**
 * The CSS custom property the library injects for a `LEGIBLE` reference.
 *
 * @param {String} reference - `main.x` or `left.x`
 * @returns {String} the custom property name
 */
function variableName(reference) {

	const [group, key] = reference.split('.');

	return `--${group === 'main' ? 'mc' : 'lc'}-${key}`;
}

/**
 * Our theme object as the custom properties the library derives from it.
 *
 * Mirrors what `VueSettingsPanel` does on its root element: the two column
 * groups become prefixed variables, the rest become fixed names.
 *
 * @param {Object} theme - the result of `settingsPanelTheme`
 * @returns {Object} custom property names to values
 */
function flattenTheme(theme) {

	const flat = {};

	for (const [key, value] of Object.entries(theme.leftColumn ?? {}))
		flat[`--lc-${key}`] = value;

	for (const [key, value] of Object.entries(theme.mainColumn ?? {}))
		flat[`--mc-${key}`] = value;

	return flat;
}

/**
 * The library's shipped stylesheet, with the base64 font faces cut out.
 *
 * They are 2.4MB of the 2.5MB, and their `url(data:...;base64,...)` values
 * contain semicolons, which would wreck the declaration splitting below.
 *
 * Read off disk, resolved through the package's own `exports` map so it
 * survives hoisting. NOT `import ... from '....css?raw'`: vitest externalises
 * CSS by default, so that import hands back an EMPTY STRING, and a test that
 * searches an empty string for things it disapproves of finds none of them and
 * passes. That is what the subset assertion above did on its first run. Hence
 * the length guard here and the two positive assertions there.
 *
 * @returns {String} the CSS
 */
function stylesheet() {

	const path = createRequire(import.meta.url).resolve('vue-settings-panel/dist/style.css');
	const css = readFileSync(path, 'utf8').replace(/@font-face\s*\{[^}]*\}/g, '');

	if (css.length < 10000)
		throw new Error(`the panel stylesheet read as ${css.length} bytes, from ${path}`);

	return css;
}

/**
 * Every `--lc-*` / `--mc-*` variable the stylesheet actually reads.
 *
 * @param {String} css - the stylesheet
 * @returns {Set<String>} custom property names
 */
function variablesReadBy(css) {
	return new Set([...css.matchAll(/var\(\s*(--(?:lc|mc)-[A-Za-z]+)/g)].map((m) => m[1]));
}

/**
 * Which CSS properties each of those variables is used for.
 *
 * `color` means the library draws text in it; `background-color` means it is a
 * surface. Several keys are both, which is worth knowing before choosing one.
 *
 * @param {String} css - the stylesheet
 * @returns {Map<String, Set<String>>} variable name to property names
 */
function propertiesUsing(css) {

	const uses = new Map();

	for (const [, body] of css.matchAll(/\{([^{}]*)\}/g))
		for (const declaration of body.split(';')) {

			const colon = declaration.indexOf(':');
			if (colon < 0)
				continue;

			const property = declaration.slice(0, colon).trim();

			for (const [, name] of declaration.slice(colon + 1)
				.matchAll(/var\(\s*(--(?:lc|mc)-[A-Za-z]+)/g)) {

				if (!uses.has(name))
					uses.set(name, new Set());

				uses.get(name).add(property);
			}
		}

	return uses;
}

/**
 * WCAG relative luminance.
 *
 * @param {String} hex - `#rrggbb`
 * @returns {Number} 0 for black, 1 for white
 */
function luminance(hex) {

	const channels = [1, 3, 5].map((i) => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : (((c + 0.055) / 1.055) ** 2.4);
	});

	return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

/**
 * WCAG contrast ratio between two colours.
 *
 * @param {String} a - `#rrggbb`
 * @param {String} b - `#rrggbb`
 * @returns {Number} 1 for identical colours, 21 for black on white
 */
function contrast(a, b) {

	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);

	return (high + 0.05) / (low + 0.05);
}
