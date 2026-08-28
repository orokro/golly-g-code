<!--
	@file InspectorWindow.vue
	@description Phase 2 stand-in for the Inspector window.

	The contents are a placeholder; the instrumentation is not. It registers with
	the app's single render driver and counts the frames it is handed, so a
	hidden window whose count keeps climbing is visible as a bug rather than only
	as a warm laptop. See windows/_placeholder.js.
-->
<template>
	<div ref="body" class="placeholder">
		<h2>{{ title }}</h2>
		<p>Properties of whatever is selected. Scratch-built, validated with Valibot.</p>
		<dl>
			<dt>visible</dt><dd :class="{ on: visible }">{{ visible ? 'yes' : 'no' }} <span class="src">via {{ source }}</span></dd>
			<dt>frames</dt><dd class="count">{{ frames }}</dd>
			<dt>size</dt><dd>{{ sizeLabel }}</dd>
		</dl>
	</div>
</template>

<script setup>

import { ref } from 'vue';
import { usePlaceholder } from './_placeholder.js';

/** @type {import('vue').Ref} The root element, for size and visibility. */
const body = ref(null);

const { title, visible, source, frames, sizeLabel } = usePlaceholder('Inspector', body);

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
		margin: 0 0 12px;
		max-width: 60ch;
		color: var(--gg-text-muted);
	}

	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px 12px;
		margin: 0;
		font-size: 12px;
	}

	dt {
		color: var(--gg-text-muted);
	}

	dd {
		margin: 0;
	}

	dd.on {
		color: var(--gg-cut);
	}

	dd.count {
		color: var(--gg-accent);
	}

	.src {
		color: var(--gg-text-muted);
	}

</style>
