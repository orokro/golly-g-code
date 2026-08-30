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
				<AppHeader
					:dark="palette.dark"
					:name="file.name.value"
					:dirty="store.dirty.value"
					:recent="file.recent.value"
					@new-project="file.newProject"
					@open-project="file.open"
					@open-recent="file.open"
					@save-project="file.save"
					@save-project-as="file.saveAs"
					@reset-layout="resetLayout"
					@toggle-theme="toggleTheme"
				/>
			</template>

			<template #statusBar>
				<AppStatusBar :hint="hint" :state="codegenState"/>
			</template>

		</WindowManager>

	</main>
</template>

<script setup>

import { ref, computed, shallowReactive, provide, onMounted, onBeforeUnmount, watchEffect } from 'vue';
import { WindowManager } from 'vue-win-mgr';
import { createSettings } from 'vue-settings-panel';

import AppHeader from './AppHeader.vue';
import AppStatusBar from './AppStatusBar.vue';

import { createProject } from '@core/project/document.js';

import { availableWindows, windowSlugs } from './windows/registry.js';
import { settingsSpec } from './settings/spec.js';
import { createProjectStore } from './composables/projectStore.js';
import { useProjectFile } from './composables/projectFile.js';
import { defaultLayout } from './layout/defaultLayout.js';
import { createLayoutStore } from './composables/layoutStore.js';
import { createRenderDriver } from './composables/renderDriver.js';
import { presets, windowManagerTheme, applyPalette } from './theme/palette.js';

/** @type {import('vue').Ref} The manager component, for imperative resets. */
const managerEl = ref(null);

/**
 * The Electron surface, or a stand-in when there is not one.
 *
 * The renderer is also built and driven in a plain browser for verification,
 * where there is no preload and so no `gollyAPI`. Rather than guard every call
 * site, the stand-in answers every dialog the way Cancel does: the buttons stay
 * live and simply do nothing, which is what makes the layout and theming
 * verifiable outside Electron at all.
 */
const api = globalThis.gollyAPI ?? {
	openFileDialog: async () => null,
	saveFileDialog: async () => null,
	messageBox: async () => 2,
	readBinary: async () => { throw new Error('This build has no access to the filesystem.'); },
	writeBinary: async () => { throw new Error('This build has no access to the filesystem.'); },
	onCloseRequested: () => () => {},
	confirmClose: async () => false,
};

/**
 * The open project.
 *
 * One store, created here, provided to everything. A factory rather than a
 * singleton, so multi-project tabs stay possible later without unpicking an
 * import from every component that ever wanted the document.
 */
const store = createProjectStore({ project: createProject() });
provide('projectStore', store);

/** New, Open, Save, and the unsaved-changes guard they all go through. */
const file = useProjectFile({ store, api });
provide('projectFile', file);

/** @type {Function|null} Stops listening for close requests. */
let unlistenClose = null;

/**
 * Every application setting, live.
 *
 * `createSettings` supplies the spec's defaults, and this is the one place an
 * application setting exists. The Settings window is given
 * THIS object rather than a copy of it: the panel writes straight into it, and
 * anything derived from it here updates without a synchronising step.
 *
 * That matters because the first version had two -- a palette ref here and a
 * settings object inside the window -- and neither could see the other. The
 * header button restyled the app but not the panel; the panel's own theme
 * picker did nothing and reported the wrong value. Both were the same bug.
 *
 * `shallowReactive`, not `reactive`, per CONVENTIONS.md: a one-level proxy, so
 * writes to these scalars trigger and nothing nested is ever wrapped. The spread
 * reads the values out of whatever `createSettings` returns, so this owns a
 * plain object of its own rather than layering a proxy over the library's.
 *
 * The panel writes into it with `settings[key] = value`, guarded by an
 * `isReactive` check -- which `shallowReactive` satisfies. Read out of the
 * library's source rather than assumed, along with the fact that it emits the
 * whole settings object and not the changed key.
 */
const settings = shallowReactive({ ...createSettings(settingsSpec) });
provide('appSettings', settings);

/**
 * The active palette, DERIVED from the theme setting rather than stored.
 *
 * Derived so there is nothing to keep in step: whoever writes `settings.theme`
 * -- the header, the panel, or a restored project later -- moves the whole app.
 * An unrecognised name falls back to dark rather than leaving the app unstyled.
 */
const palette = computed(() => presets[settings.theme] ?? presets.dark);
provide('palette', palette);

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

/**
 * Switches presets, from the header button.
 *
 * Writes the SETTING, not the palette -- the palette is derived from it, so
 * setting the palette directly would be overwritten on the next recompute and
 * would leave the Settings panel showing the old theme.
 */
function toggleTheme() {
	settings.theme = palette.value.dark ? 'light' : 'dark';
}

// the window title carries the unsaved marker, so it is visible without the
// header being on screen -- in the taskbar, in a window switcher
watchEffect(() => { document.title = file.title.value; });

onMounted(() => {

	// A layout change still inside the debounce window when the app quits would
	// otherwise be lost, which is exactly the change the user just made.
	window.addEventListener('beforeunload', layoutStore.flush);

	// Main asks before letting the window close; the answer is the same guard
	// every other destructive action goes through, so closing cannot be the one
	// path that forgets to ask.
	unlistenClose = api.onCloseRequested(async () => {
		layoutStore.flush();
		await api.confirmClose(await file.requestClose());
	});
});

onBeforeUnmount(() => {
	unlistenClose?.();
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
