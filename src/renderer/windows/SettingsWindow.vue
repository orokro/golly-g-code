<!--
	@file SettingsWindow.vue
	@description Application settings, via vue-settings-panel.

	The spec lives in settings/spec.js so it can be asserted on its own. This
	file is the mounting, the theme derivation, and the one interesting bit: the
	panel is a second library with its own styling convention, so it is the real
	test of whether the palette actually drives everything or merely looks like
	it does.
-->
<template>
	<div ref="body" class="settingsWindow">
		<VueSettingsPanel
			:settings="settings"
			:specification="settingsSpec"
			:themeColors="panelTheme"
			@settings-changed="onChanged"
		/>
	</div>
</template>

<script setup>

import { ref, computed, inject } from 'vue';
import { VueSettingsPanel, createSettings } from 'vue-settings-panel';

import { settingsSpec } from '../settings/spec.js';
import { settingsPanelTheme, presets } from '../theme/palette.js';

/** @type {import('vue').Ref} The root element. */
const body = ref(null);

/** The live settings object, filled from the spec's defaults. */
const settings = createSettings(settingsSpec);

/**
 * The app's palette, provided by App.vue.
 *
 * Injected rather than imported so the panel restyles with the rest of the app
 * instead of holding its own opinion, which is the drift the palette module
 * exists to prevent.
 */
const palette = inject('palette', null);

const panelTheme = computed(() => settingsPanelTheme(palette?.value ?? presets.dark));

/** Lets the app act on a setting the moment it changes. */
const applySetting = inject('applySetting', null);

/**
 * Passes changes up. Nothing is persisted here yet — that is Phase 3, along
 * with the rest of the project/application split.
 *
 * @param {Object} changed - the settings object after the change
 */
function onChanged(changed) {
	applySetting?.(changed);
}

</script>

<style scoped>

	.settingsWindow {
		box-sizing: border-box;
		height: 100%;
		background: var(--gg-surface);
		overflow: hidden;
	}

</style>
