<!--
	@file CodeEditorWindow.vue
	@description The generated program, and the button that sends it to the
	machine.

	Read-only, deliberately. The program is a VIEW of the document, regenerated
	whenever the document moves, so anything typed here would be overwritten by
	the next keystroke in the Inspector. The plan's "Edit G-code" toggle, which
	suspends regeneration while you hand-edit, is a real feature and a separate
	one; offering an editable box that silently discards what you type is worse
	than offering a read-only one.

	Monaco is not here yet either. What it buys — syntax colour, folding, a
	minimap — is worth several megabytes of parse at boot, and what the window
	has to do first is show the program, say whether it is current, point at the
	selected job, and export. That is all below, and Monaco can replace the
	middle of it without touching the rest.
-->
<template>
	<div class="code">

		<div class="bar">

			<button
				class="primary"
				:disabled="!program.canExport.value || file.exporting.value"
				:title="exportTitle"
				@click="file.exportProgram()"
			>{{ file.exporting.value ? 'Exporting…' : 'Export G-code' }}</button>

			<span class="state" :class="blocked ? 'failed' : program.state.value">{{ stateLabel }}</span>

			<span v-if="!blocked" class="summary">{{ summary }}</span>

			<button
				v-if="!blocked && program.warnings.value.length > 0"
				class="warnings"
				:class="{ open: showWarnings }"
				@click="showWarnings = !showWarnings"
			>{{ program.warnings.value.length }} note{{ program.warnings.value.length === 1 ? '' : 's' }}</button>

		</div>

		<ul v-if="showWarnings && program.warnings.value.length > 0" class="notes">
			<li v-for="(note, i) in program.warnings.value" :key="i">{{ note }}</li>
		</ul>

		<p v-if="file.error.value" class="error">{{ file.error.value }}</p>

		<div v-if="program.blocked.value.length > 0" class="blocked">
			<h3>This project cannot be cut yet</h3>
			<ul>
				<li v-for="(problem, i) in program.blocked.value" :key="i">{{ problem.message }}</li>
			</ul>
		</div>

		<div v-else ref="scroller" class="scroll" @scroll="onScroll">
			<div class="spacer" :style="{ height: `${lines.length * LINE_HEIGHT}px` }">
				<div class="slice" :style="{ transform: `translateY(${range.offset}px)` }">
					<div
						v-for="row in rows"
						:key="row.number"
						class="row"
						:class="{ mine: row.mine, comment: row.text.startsWith(';') }"
					>
						<span class="gutter">{{ row.number + 1 }}</span><code>{{ row.text }}</code>
					</div>
				</div>
			</div>
		</div>

	</div>
</template>

<script setup>

import { ref, computed, inject, watch, nextTick } from 'vue';

import { useResize } from '../composables/useResize.js';
import { State } from '../composables/useProgram.js';
import { LINE_HEIGHT, visibleRange, blockFor, scrollToLine, summarise } from './code/lines.js';

/** What each state should say in the toolbar. */
const LABEL = Object.freeze({
	[State.IDLE]: 'up to date',
	[State.QUEUED]: 'waiting for the document to settle',
	[State.GENERATING]: 'generating',
	[State.FAILED]: 'failed',
});

const store = inject('projectStore', null);
const program = inject('program', null);
const file = inject('programFile', null);

/** @type {import('vue').Ref} The scrolling element. */
const scroller = ref(null);

/** How far down it is scrolled, and how tall it is. */
const scrollTop = ref(0);
const height = ref(0);

/** Whether the notes are expanded. */
const showWarnings = ref(false);

useResize(scroller, (measured) => { height.value = measured.height; });

const lines = computed(() => program?.lines.value ?? []);

const range = computed(() => visibleRange({
	scrollTop: scrollTop.value, height: height.value, count: lines.value.length,
}));

/** The block belonging to whatever is selected, so its lines can be marked. */
const mine = computed(() =>
	blockFor(program?.blocks.value ?? [], store?.selection.value.ids ?? []));

/** Only the lines actually on screen, each carrying its real line number. */
const rows = computed(() => {

	const { start, end } = range.value;
	const block = mine.value;
	const out = [];

	for (let number = start; number < end; number++)
		out.push({
			number,
			text: lines.value[number] ?? '',
			mine: block !== null && number >= block.from && number <= block.to,
		});

	return out;
});

/** Whether a diagnostic is stopping the program from existing at all. */
const blocked = computed(() => (program?.blocked.value.length ?? 0) > 0);

/**
 * What the toolbar says about the program's state.
 *
 * "up to date · 0 lines" beside "this project cannot be cut yet" is technically
 * true and reads as a contradiction, which is how a status line stops being
 * believed. Blocked is a state of its own up here.
 */
const stateLabel = computed(() =>
	(blocked.value ? 'cannot be cut yet' : LABEL[program?.state.value] ?? ''));

const summary = computed(() => summarise(program?.stats.value ?? null, lines.value.length));

const exportTitle = computed(() => {
	if (file?.error.value)
		return file.error.value;
	if (program?.blocked.value.length > 0)
		return 'Fix the errors in the outliner first.';
	if (program?.stale.value)
		return 'Waiting for the program to catch up with the document.';
	return 'Write the program to a .nc file.';
});

/**
 * Records the scroll position.
 *
 * @param {Event} event - the scroll event
 */
function onScroll(event) {
	scrollTop.value = event.target.scrollTop;
}

// Selecting a job in the outliner brings its block into view. Only when it is
// not already on screen -- scrolling a window the user is reading, because they
// clicked something elsewhere, is worse than not scrolling at all.
watch(mine, async (block) => {

	if (block === null || scroller.value === null)
		return;

	await nextTick();

	const to = scrollToLine(block.from, {
		scrollTop: scrollTop.value, height: height.value, lineHeight: LINE_HEIGHT,
	});

	if (to !== null)
		scroller.value.scrollTop = to;
});

</script>

<style scoped>

	.code {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--gg-surface);
		color: var(--gg-text);
		font: 12px/1.5 system-ui, sans-serif;
	}

	.bar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--gg-border);
		flex: none;
	}

	button {
		font: inherit;
		padding: 3px 10px;
		border: 1px solid var(--gg-border);
		border-radius: 3px;
		background: var(--gg-surface-raised);
		color: var(--gg-text);
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.45;
		cursor: default;
	}

	button.primary:not(:disabled) {
		border-color: var(--gg-accent);
		color: var(--gg-accent);
	}

	button.warnings {
		margin-left: auto;
		color: var(--gg-warning, #d8a657);
	}

	.state {
		font-size: 11px;
		color: var(--gg-text-muted);
	}

	.state.idle {
		color: var(--gg-cut, var(--gg-accent));
	}

	.state.failed {
		color: var(--gg-error, #e06c75);
	}

	.summary {
		font-size: 11px;
		color: var(--gg-text-muted);
	}

	.notes {
		flex: none;
		margin: 0;
		padding: 6px 10px 6px 26px;
		max-height: 30%;
		overflow: auto;
		border-bottom: 1px solid var(--gg-border);
		color: var(--gg-text-muted);
		font-size: 11px;
	}

	.error {
		flex: none;
		margin: 0;
		padding: 6px 10px;
		border-bottom: 1px solid var(--gg-border);
		color: var(--gg-error, #e06c75);
	}

	.blocked {
		padding: 12px 14px;
		overflow: auto;
	}

	.blocked h3 {
		margin: 0 0 6px;
		font-size: 12px;
		color: var(--gg-error, #e06c75);
	}

	.blocked ul {
		margin: 0;
		padding-left: 18px;
		color: var(--gg-text-muted);
	}

	.scroll {
		flex: 1;
		overflow: auto;
		position: relative;
	}

	.spacer {
		position: relative;
	}

	.slice {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
	}

	.row {
		display: flex;
		height: 18px;
		line-height: 18px;
		font: 12px/18px ui-monospace, Menlo, Consolas, monospace;
		white-space: pre;
	}

	.row.mine {
		background: color-mix(in srgb, var(--gg-accent) 14%, transparent);
	}

	.row.comment code {
		color: var(--gg-text-muted);
	}

	.gutter {
		flex: none;
		width: 5.5ch;
		padding-right: 10px;
		text-align: right;
		color: var(--gg-text-muted);
		opacity: 0.6;
		user-select: none;
	}

	code {
		font: inherit;
	}

</style>
