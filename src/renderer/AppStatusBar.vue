<!--
	@file AppStatusBar.vue
	@description The bar across the bottom: hints, and what codegen is doing.

	The codegen state is the important half. Toolpaths regenerate as you change
	things, with no Generate button (D-workflow), which means the one question a
	user has — "is what I am looking at current?" — has no other answer on screen.
	A stale result that looks settled is the failure mode this exists to prevent,
	so `stale` is styled to be noticed rather than to be tasteful.
-->
<template>
	<div class="status">

		<span class="hint">{{ hint }}</span>

		<span class="spacer"/>

		<span class="codegen" :class="state">
			<span class="dot"/>
			{{ label }}
		</span>

	</div>
</template>

<script setup>

import { computed } from 'vue';

const props = defineProps({

	/** Whatever the hovered control wants to say. */
	hint: { type: String, default: '' },

	/** One of idle, queued, generating, stale. */
	state: {
		type: String,
		default: 'idle',
		validator: (value) => ['idle', 'queued', 'generating', 'stale'].includes(value),
	},
});

/** What each state says out loud. */
const LABELS = {
	idle: 'up to date',
	queued: 'queued',
	generating: 'generating…',
	stale: 'out of date',
};

const label = computed(() => LABELS[props.state] ?? props.state);

</script>

<style scoped>

	.status {
		display: flex;
		align-items: center;
		gap: 10px;
		height: 100%;
		padding: 0 10px;
		color: var(--gg-text-muted);
		font: 11px/1 ui-monospace, Menlo, Consolas, monospace;
	}

	.spacer {
		flex: 1;
	}

	.codegen {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: currentColor;
	}

	.codegen.idle {
		color: var(--gg-text-muted);
	}

	.codegen.queued,
	.codegen.generating {
		color: var(--gg-accent);
	}

	/* deliberately loud: a stale result that looks settled is the whole hazard */
	.codegen.stale {
		color: var(--gg-warning);
	}

	.codegen.generating .dot {
		animation: pulse 900ms ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.25; }
	}

</style>
