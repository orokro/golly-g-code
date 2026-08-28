<!--
	@file App.vue
	@description Application root: the window manager, themed and persistent.

	Phase 2. The windows themselves are stand-ins; what is real here is the
	layout, the theme, saving and restoring where the user put things, and the
	single render driver that every view will register with.

	The render driver is provided rather than imported by the views, so there is
	exactly one loop for the application and a test can substitute a fake clock
	for it. See composables/renderDriver.js for why one loop and not one each.
-->
<template>
	<main @contextmenu.prevent>

		<WindowManager
			ref="managerEl"
			:availableWindows="availableWindows"
			:defaultLayout="startingLayout"
			:showTopBar="true"
			:showStatusBar="true"
			:splitMergeHandles="true"
			:showMergeButtons="true"
			:keepEmptyFrames="true"
			:theme="managerTheme"
			@layout-changed="onLayoutChanged"
		>
			<template #topBar>
				<AppHeader :dark="palette.dark" @reset-layout="resetLayout" @toggle-theme="toggleTheme"/>
			</template>

			<template #statusBar>
				<AppStatusBar :hint="hint" :state="codegenState"/>
			</template>

		</WindowManager>

	</main>
</template>

<script setup>

import { ref, shallowRef, computed, provide, onMounted, onBeforeUnmount, watchEffect } from 'vue';
import { WindowManager } from 'vue-win-mgr';

import AppHeader from './AppHeader.vue';
import AppStatusBar from './AppStatusBar.vue';

import { availableWindows, windowSlugs } from './windows/registry.js';
import { defaultLayout } from './layout/defaultLayout.js';
import { createLayoutStore } from './composables/layoutStore.js';
import { createRenderDriver } from './composables/renderDriver.js';
import { presets, windowManagerTheme, applyPalette } from './theme/palette.js';

/** @type {import('vue').Ref} The manager component, for imperative resets. */
const managerEl = ref(null);

/** The active palette. Shallow: a palette is replaced wholesale, never edited. */
const palette = shallowRef(presets.dark);

/** What the status bar says on the left. */
const hint = ref('');

/** What codegen is doing. Wired to the real pipeline in Phase 3. */
const codegenState = ref('idle');

/** Remembers where the user put their windows. */
const layoutStore = createLayoutStore({ knownSlugs: windowSlugs });

/**
 * The one render loop for the whole app.
 *
 * Provided, not imported, so every view shares it and a test can swap it out.
 */
const renderDriver = createRenderDriver();
provide('renderDriver', renderDriver);

/** The saved layout if there is a usable one, otherwise the default. */
const startingLayout = layoutStore.load() ?? defaultLayout();

/** The window manager's theme prop, derived from the palette. */
const managerTheme = computed(() => windowManagerTheme(palette.value));

// keep the CSS variables in step with the palette; the manager takes a prop,
// everything else reads the variables
watchEffect(() => applyPalette(palette.value));

/**
 * Records a layout change. Debounced inside the store, because dragging a
 * splitter emits one of these per mouse move.
 *
 * @param {Object} layout - the manager's layout description
 */
function onLayoutChanged(layout) {
	layoutStore.save(layout);
}

/** Forgets the saved layout and puts the default back. */
function resetLayout() {
	layoutStore.clear();
	managerEl.value?.loadLayout?.(defaultLayout());
}

/** Switches presets. */
function toggleTheme() {
	palette.value = palette.value.dark ? presets.light : presets.dark;
}

onMounted(() => {

	// A layout change still inside the debounce window when the app quits would
	// otherwise be lost, which is exactly the change the user just made.
	window.addEventListener('beforeunload', layoutStore.flush);
});

onBeforeUnmount(() => {
	window.removeEventListener('beforeunload', layoutStore.flush);
	layoutStore.flush();
	renderDriver.stop();
});

</script>

<style>

	html, body, #app {
		height: 100%;
		margin: 0;
		background: var(--gg-background);
		color: var(--gg-text);
	}

	main {
		height: 100%;
	}

</style>
