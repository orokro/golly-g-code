<!--
	@file AppHeader.vue
	@description The bar across the top: menus, and the theme switch.

	Not a window. It sits in the manager's top-bar slot so it cannot be closed,
	moved or tabbed away, which is what you want of the thing holding "reset
	layout" — the escape hatch has to survive whatever the user did to the layout
	to need it.
-->
<template>
	<div class="header">

		<span class="brand">GollyGCode</span>

		<button v-for="item in menus" :key="item.label" type="button"
			class="menu" :disabled="item.disabled" @click="item.action">{{ item.label }}</button>

		<span class="spacer"/>

		<button type="button" class="menu" @click="$emit('toggle-theme')">
			{{ dark ? 'Light' : 'Dark' }} theme
		</button>

	</div>
</template>

<script setup>

defineProps({
	/** True when the dark preset is active, so the button offers the other one. */
	dark: { type: Boolean, default: true },
});

const emit = defineEmits(['reset-layout', 'toggle-theme']);

/**
 * The menus. Most are Phase 3 work and are disabled rather than absent, so the
 * shape of the finished bar is visible while it is being built.
 */
const menus = [
	{ label: 'New', disabled: true, action: () => {} },
	{ label: 'Open…', disabled: true, action: () => {} },
	{ label: 'Save', disabled: true, action: () => {} },
	{ label: 'Reset layout', disabled: false, action: () => emit('reset-layout') },
];

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

	.spacer {
		flex: 1;
	}

</style>
