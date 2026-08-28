<!--
	@file SettingsWindow.vue
	@description Application settings, via vue-settings-panel.

	The spec lives in settings/spec.js so it can be asserted on its own. This
	file is the mounting, the theme derivation, and the one interesting bit: the
	panel is a second library with its own styling convention, so it is the real
	test of whether the palette actually drives everything or merely looks like
	it does.

	It did not, at first, in both directions at once -- see the comments below and
	on `settingsPanelTheme` in theme/palette.js.
-->
<template>
	<div class="settingsWindow">
		<VueSettingsPanel
			:settings="settings"
			:specification="settingsSpec"
			:themeColors="panelTheme"
		/>
	</div>
</template>

<script setup>

import { computed, inject } from 'vue';
import { VueSettingsPanel, createSettings } from 'vue-settings-panel';

import { settingsSpec } from '../settings/spec.js';
import { settingsPanelTheme, presets } from '../theme/palette.js';

/**
 * The application's live settings object, provided by App.vue.
 *
 * THE SAME object, not a copy: the panel writes a change straight into it, and
 * everything derived from it upstream -- the palette, for one -- follows without
 * an event round trip. That is why there is no `@settings-changed` handler here;
 * by the time the panel emits, the change has already been applied.
 *
 * The fallback is so the window can be mounted on its own in a test. It is a
 * dead end -- nothing outside sees it -- which is exactly what the whole app did
 * before App.vue provided anything.
 */
const settings = inject('appSettings', null) ?? createSettings(settingsSpec);

/**
 * The app's palette, provided by App.vue.
 *
 * Injected rather than imported so the panel restyles with the rest of the app
 * instead of holding its own opinion, which is the drift the palette module
 * exists to prevent. The library watches `themeColors` deeply, so a new object
 * out of this computed is all it takes.
 */
const palette = inject('palette', null);

const panelTheme = computed(() => settingsPanelTheme(palette?.value ?? presets.dark));

</script>

<style scoped>

	.settingsWindow {
		box-sizing: border-box;
		height: 100%;
		background: var(--gg-surface);
		overflow: hidden;
	}

	/*
		Corrections to the library's stylesheet.

		Everything below patches a colour the library hard-codes rather than
		exposing, which the `themeColors` prop therefore cannot reach. Each was
		written for a light theme and disappears on a dark one: black at 5%
		opacity is a visible hairline on white and nothing at all on #16161a.

		These are :deep() rather than a fork because vue-settings-panel is ours --
		the right home for them is the library, and this is the list to move.
	*/

	/* The left column has no background of its own: `leftColumn.bgColor` is set
	   and no rule reads it, so the categories float on the window surface. */
	.settingsWindow :deep(.left-column) {
		background: var(--gg-surface-raised);
		border-right: 1px solid var(--gg-border);
	}

	/* Separators drawn as rgba(0, 0, 0, 0.05). */
	.settingsWindow :deep(.left-column .header),
	.settingsWindow :deep(.main-column .search-sticky),
	.settingsWindow :deep(.category-header) {
		border-bottom-color: var(--gg-border);
	}

	/*
		Hover feedback, same problem.

		`:not(.selected)` because without it this rule ties with the library's
		selected-category rule on specificity and wins on order, so the category
		you are pointing at loses its accent background while keeping its
		accent-coloured TEXT -- near-black on a dark grey, and invisible. It only
		showed up in a screenshot taken with the cursor still resting on it.
	*/
	.settingsWindow :deep(.category-item:not(.selected):hover),
	.settingsWindow :deep(.subcategory-item:not(.selected):hover) {
		background-color: var(--gg-surface-sunken);
	}

	/* `categoryHeaderColor` does double duty as a background here, with white
	   text welded on. It is our accent, so the text on it is the accent's. */
	.settingsWindow :deep(.radio-item.active),
	.settingsWindow :deep(.tag-badge) {
		color: var(--gg-accent-text);
	}

</style>
