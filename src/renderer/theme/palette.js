/**
 * @file palette.js
 * @description The one place a colour is decided.
 *
 * Two libraries in this app style themselves through different conventions:
 * `vue-win-mgr` takes a flat object of named colours as a prop, and
 * `vue-settings-panel` reads grouped CSS custom properties. Left alone that is
 * two palettes, and they drift — a panel that is very slightly the wrong grey
 * against the frame behind it, forever.
 *
 * So a palette here is a small set of ROLES, and each consumer's variables are
 * derived from those roles. Adding a preset means choosing about a dozen
 * colours, not auditing every component.
 *
 * Roles rather than names on purpose: `surface` and `surfaceRaised` say where a
 * colour belongs, where `grey800` says only what it is, and a light theme built
 * out of `grey800` reads as a set of lies.
 */

/**
 * @typedef {Object} Palette
 * @property {String} name - preset name
 * @property {Boolean} dark - true when this is a dark preset
 * @property {String} background - behind everything
 * @property {String} surface - a window's body
 * @property {String} surfaceRaised - headers, tab strips, bars
 * @property {String} surfaceSunken - wells, insets, code backgrounds
 * @property {String} border - hairlines between regions
 * @property {String} text - body text
 * @property {String} textMuted - secondary text and disabled states
 * @property {String} accent - selection, focus, the active tab
 * @property {String} accentText - text drawn on the accent
 * @property {String} warning - something the user should look at
 * @property {String} danger - something that would ruin a workpiece
 * @property {String} cut - toolpath at cutting depth
 * @property {String} travel - moves between cuts
 * @property {String} stock - material
 */

/** The dark preset. The default, because a shop is usually dim and this is CAM. */
export const dark = Object.freeze({
	name: 'dark',
	dark: true,
	background: '#0f0f12',
	surface: '#16161a',
	surfaceRaised: '#1d1d23',
	surfaceSunken: '#0b0b0e',
	border: '#2a2a33',
	text: '#d7d7de',
	textMuted: '#8a8a95',
	accent: '#5ec8d8',
	accentText: '#0f0f12',
	warning: '#e8b64c',
	danger: '#e0798f',
	cut: '#7ee081',
	travel: '#e0798f',
	stock: '#c9a227',
});

/** The light preset. */
export const light = Object.freeze({
	name: 'light',
	dark: false,
	background: '#e9e9ec',
	surface: '#f7f7f9',
	surfaceRaised: '#ffffff',
	surfaceSunken: '#e2e2e6',
	border: '#c8c8d0',
	text: '#22222a',
	textMuted: '#63636e',
	accent: '#1c7f8f',
	accentText: '#ffffff',
	warning: '#8a5d00',
	danger: '#a32741',
	cut: '#1f7a35',
	travel: '#a32741',
	stock: '#c9a227',
});

/** Every preset, by name. */
export const presets = Object.freeze({ dark, light });


/**
 * The window manager's theme prop, derived from a palette.
 *
 * `vue-win-mgr` takes a flat object of specific colour names. Mapping them here
 * rather than writing them into a component keeps the derivation in one place
 * and makes a new preset a data change.
 *
 * @param {Palette} palette - the palette
 * @returns {Object} the `theme` prop for `<WindowManager>`
 */
export function windowManagerTheme(palette) {

	return {
		systemBGColor: palette.background,
		topBarBGColor: palette.surfaceRaised,
		statusBarBGColor: palette.surfaceRaised,
		frameBGColor: palette.surface,
		mwiBGColor: palette.background,

		menuBGColor: palette.surfaceRaised,
		menuActiveBGColor: palette.accent,
		menuTextColor: palette.text,
		menuDisabledTextColor: palette.textMuted,

		frameHeaderColor: palette.surfaceRaised,
		frameTabsHeaderColor: palette.surfaceRaised,
		frameTabsColor: palette.surface,
		frameTabsActiveColor: palette.accent,
		windowTitleTextColor: palette.text,

		hamburgerIconColor: palette.textMuted,
		hamburgerIconColorHover: palette.text,
		hamburgerCircleColor: palette.surface,
		hamburgerCircleColorHover: palette.border,

		closeButtonCircle: palette.surface,
		closeButtonCircleHover: palette.danger,
		closeButtonXColor: palette.textMuted,
		closeButtonXColorHover: palette.accentText,
	};
}


/**
 * Every CSS custom property the app and the settings panel read.
 *
 * Returned as a plain object rather than written to the document, so it can be
 * asserted in a test without a DOM. `applyPalette` is what actually sets them.
 *
 * @param {Palette} palette - the palette
 * @returns {Object} custom property names to values
 */
export function cssVariables(palette) {

	const own = {
		'--gg-background': palette.background,
		'--gg-surface': palette.surface,
		'--gg-surface-raised': palette.surfaceRaised,
		'--gg-surface-sunken': palette.surfaceSunken,
		'--gg-border': palette.border,
		'--gg-text': palette.text,
		'--gg-text-muted': palette.textMuted,
		'--gg-accent': palette.accent,
		'--gg-accent-text': palette.accentText,
		'--gg-warning': palette.warning,
		'--gg-danger': palette.danger,
		'--gg-cut': palette.cut,
		'--gg-travel': palette.travel,
		'--gg-stock': palette.stock,
	};

	// vue-settings-panel's grouped variables: `lc` for its label column, `mc`
	// for the main content. Derived rather than chosen, so a preset cannot
	// disagree with itself.
	const settingsPanel = {
		'--lc-bg-color': palette.surfaceRaised,
		'--lc-text-color': palette.text,
		'--lc-border-color': palette.border,
		'--lc-hover-bg-color': palette.surface,
		'--lc-active-bg-color': palette.accent,
		'--lc-active-text-color': palette.accentText,

		'--mc-bg-color': palette.surface,
		'--mc-text-color': palette.text,
		'--mc-muted-text-color': palette.textMuted,
		'--mc-border-color': palette.border,
		'--mc-input-bg-color': palette.surfaceSunken,
		'--mc-accent-color': palette.accent,
	};

	return { ...own, ...settingsPanel };
}


/**
 * Writes a palette onto an element's inline style.
 *
 * @param {Palette} palette - the palette
 * @param {Object} [element] - defaults to the document root
 */
export function applyPalette(palette, element = globalThis.document?.documentElement) {

	if (element == null)
		return;

	for (const [name, value] of Object.entries(cssVariables(palette)))
		element.style.setProperty(name, value);

	element.dataset.theme = palette.name;
}
