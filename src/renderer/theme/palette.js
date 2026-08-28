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

	return own;
}


/**
 * `vue-settings-panel`'s `themeColors` prop, derived from a palette.
 *
 * An earlier version of this file invented a set of `--lc-*` and `--mc-*` CSS
 * variables from a description of how the library themes itself, and a test
 * asserted they agreed with our own variables. They did agree. The library does
 * not read them: it takes a NESTED OBJECT and injects its own variables from it.
 * A test that checks two things we wrote against each other proves they are
 * consistent, not that either is correct.
 *
 * The mapping below was then written from the KEY NAMES, which is the same
 * mistake wearing a different hat. Read against the library's shipped
 * stylesheet, several of the names mean the opposite of what they say:
 *
 *   `categoryHeaderColor`     is the category TITLE's text colour (and its
 *                             icon), NOT a header background. It is also the
 *                             background of an active Select chip and of a tag
 *                             badge, both of which hard-code white text on it.
 *   `subcategoryHeaderColor`  likewise: the subcategory TITLE's text colour.
 *   `categoryTextColor` (mc)  the category DESCRIPTION under the title.
 *   `categoryColor` (lc)      the category names down the side.
 *
 * Set to surface colours -- which is what the names suggest -- they render as
 * dark-grey text on dark grey, which is precisely what the panel did.
 *
 * Eleven of the eighteen keys the library documents are dead: it sets the
 * variable and no rule reads it. They are still filled in here, because the
 * library is ours and a later version may well start reading them, but they are
 * marked, so nobody tunes a colour that cannot appear on screen. The keys that
 * ARE read are pinned by a test that parses the shipped stylesheet, so a rename
 * upstream fails loudly instead of silently falling back to the light defaults.
 *
 * @param {Palette} palette - the palette
 * @returns {Object} the `themeColors` prop for `<VueSettingsPanel>`
 */
export function settingsPanelTheme(palette) {

	return {

		leftColumn: {
			bgColor: palette.surfaceRaised,                  // unread; see SettingsWindow.vue
			categoriesBoxBgColor: 'transparent',             // unread
			categoriesBoxBorder: 'none',                     // unread
			categoryColor: palette.text,                     // the category names
			categoryTextColor: palette.text,                 // unread
			selectedCategoryBgColor: palette.accent,
			selectedCategoryTextColor: palette.accentText,
			searchBgColor: palette.surfaceSunken,
			searchXColor: palette.textMuted,
			searchTextColor: palette.text,
		},

		mainColumn: {
			bgColor: palette.surface,                        // unread
			textColor: palette.text,                         // unread
			categoryHeaderColor: palette.accent,             // the category TITLE
			categoryHeaderTextColor: palette.accentText,     // unread
			categoryBorder: `1px solid ${palette.border}`,
			categoryBgColor: palette.surfaceRaised,
			categoryTextColor: palette.textMuted,            // the category description
			settingsRowBgColor: 'transparent',               // unread
			settingsRowNameColor: palette.text,
			settingsRowDescColor: palette.textMuted,
			settingsRowBorder: `1px solid ${palette.border}`,  // unread
			subcategoryHeaderColor: palette.text,            // the subcategory TITLE
			subcategoryHeaderTextColor: palette.accentText,  // unread
			subcategoryBorder: `1px solid ${palette.border}`,
			subcategoryBgColor: palette.surfaceSunken,
			subCategoryTextColor: palette.text,              // unread
			attentionColor: palette.accent,
		},

		toggle: {
			bgColor: palette.surfaceSunken,
			thumbColor: palette.text,
			activeBgColor: palette.accent,
		},

		input: {
			borderColor: palette.border,
			bgColor: palette.surfaceSunken,
			textColor: palette.text,
			focusBorderColor: palette.accent,
		},

		range: {
			thumbColor: palette.accent,
			trackColor: palette.border,
		},
	};
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
