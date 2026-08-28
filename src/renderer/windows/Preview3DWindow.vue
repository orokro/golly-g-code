<!--
	@file Preview3DWindow.vue
	@description Phase 2 stand-in for the Preview 3D window.

	Dummy contents on purpose: the shell is what is being built and tested here,
	not this. It reports its own visibility because that is the flag the render
	driver skips work on, and a fault in it would otherwise surface much later as
	an unexplained warm laptop.
-->
<template>
	<div class="placeholder" :class="{ hidden: !visible }">
		<h2>{{ title }}</h2>
		<p>Three.js view of the cut, with the material and the tool.</p>
		<p class="state">window manager reports: <b>{{ visible ? 'visible' : 'hidden' }}</b></p>
	</div>
</template>

<script setup>

import { usePlaceholder } from './_placeholder.js';

const { title, visible } = usePlaceholder('Preview 3D');

</script>

<style scoped>

	.placeholder {
		box-sizing: border-box;
		height: 100%;
		padding: 14px 16px;
		color: var(--gg-text);
		background: var(--gg-surface);
		font: 13px/1.6 ui-monospace, Menlo, Consolas, monospace;
		overflow: auto;
	}

	.placeholder h2 {
		margin: 0 0 6px;
		font-size: 13px;
		font-weight: 600;
	}

	.placeholder p {
		margin: 0 0 8px;
		max-width: 60ch;
		color: var(--gg-text-muted);
	}

	.placeholder .state b {
		color: var(--gg-accent);
	}

</style>
