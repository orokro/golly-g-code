<!--
	@file AppHeader.vue
	@description The bar across the top: menus, and the theme switch.

	Not a window. It sits in the manager's top-bar slot so it cannot be closed,
	moved or tabbed away, which is what you want of the thing holding "reset
	layout" — the escape hatch has to survive whatever the user did to the layout
	to need it.

	Presentational. Every button emits; nothing here knows what a project is.
-->
<template>
	<div class="header">

		<span class="brand">GollyGCode</span>

		<button type="button" class="menu" @click="$emit('new-project')">New</button>
		<button type="button" class="menu" @click="$emit('open-project')">Open…</button>

		<div class="recentWrap">
			<button type="button" class="menu" :disabled="recent.length === 0"
				@click="showRecent = !showRecent">Recent</button>

			<!-- a plain list rather than a menu library: it is four items and a
			     click-away, and the context-menu package can wait for the outliner -->
			<ul v-if="showRecent && recent.length > 0" class="recentList">
				<li v-for="entry in recent" :key="entry.path">
					<button type="button" class="recentItem" :title="entry.path"
						@click="choose(entry.path)">{{ entry.name }}</button>
				</li>
			</ul>
		</div>

		<button type="button" class="menu" @click="$emit('save-project')">Save</button>
		<button type="button" class="menu" @click="$emit('save-project-as')">Save As…</button>
		<button type="button" class="menu" @click="$emit('reset-layout')">Reset layout</button>

		<span class="spacer"/>

		<span v-if="dirty" class="dirty" title="Unsaved changes">•</span>
		<span class="name">{{ name }}</span>

		<button type="button" class="menu" @click="$emit('toggle-theme')">
			{{ dark ? 'Light' : 'Dark' }} theme
		</button>

	</div>
</template>

<script setup>

import { ref, onMounted, onBeforeUnmount } from 'vue';

defineProps({
	/** True when the dark preset is active, so the button offers the other one. */
	dark: { type: Boolean, default: true },

	/** The open project's name. */
	name: { type: String, default: 'Untitled' },

	/** True when there are changes that have not been saved. */
	dirty: { type: Boolean, default: false },

	/** Recently opened projects, newest first. */
	recent: { type: Array, default: () => [] },
});

const emit = defineEmits([
	'new-project', 'open-project', 'open-recent', 'save-project', 'save-project-as',
	'reset-layout', 'toggle-theme',
]);

/** Whether the recent-files list is showing. */
const showRecent = ref(false);

/**
 * Opens a recent file and puts the list away.
 *
 * @param {String} path - the file to open
 */
function choose(path) {
	showRecent.value = false;
	emit('open-recent', path);
}

/** Closes the list when the click was somewhere else. */
function onDocumentClick(event) {
	if (event.target.closest('.recentWrap') === null)
		showRecent.value = false;
}

onMounted(() => document.addEventListener('click', onDocumentClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick));

</script>

<style scoped>

	.header {
		display: flex;
		align-items: center;
		gap: 4px;
		height: 100%;
		padding: 0 10px;
		color: var(--gg-text);
		font: 12px/1 ui-monospace, Menlo, Consolas, monospace;
	}

	.brand {
		margin-right: 10px;
		font-weight: 600;
		color: var(--gg-accent);
	}

	.menu {
		padding: 5px 9px;
		border: 0;
		border-radius: 4px;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.menu:hover:not(:disabled) {
		background: var(--gg-surface);
	}

	.menu:disabled {
		color: var(--gg-text-muted);
		cursor: default;
	}

	.recentWrap {
		position: relative;
	}

	.recentList {
		position: absolute;
		top: 100%;
		left: 0;
		z-index: 50;
		min-width: 200px;
		margin: 2px 0 0;
		padding: 4px;
		border: 1px solid var(--gg-border);
		border-radius: 4px;
		background: var(--gg-surface-raised);
		list-style: none;
		box-shadow: 0 4px 14px rgb(0 0 0 / 35%);
	}

	.recentItem {
		display: block;
		width: 100%;
		padding: 6px 8px;
		border: 0;
		border-radius: 3px;
		background: transparent;
		color: var(--gg-text);
		font: inherit;
		text-align: left;
		white-space: nowrap;
		cursor: pointer;
	}

	.recentItem:hover {
		background: var(--gg-accent);
		color: var(--gg-accent-text);
	}

	.spacer {
		flex: 1;
	}

	.dirty {
		color: var(--gg-warning);
		font-size: 16px;
	}

	.name {
		margin-right: 10px;
		color: var(--gg-text-muted);
	}

</style>
