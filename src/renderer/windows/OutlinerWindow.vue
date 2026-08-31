<!--
	@file OutlinerWindow.vue
	@description The document tree.

	The logic that is worth testing is not in here — it is in outliner/rows.js,
	which flattens the tree, decides where a drag lands, and works out what a
	click with modifiers should select. This file is the markup, the pointer
	plumbing and the dispatching.

	Jobs get TWO lines. The second is the depth sentence, and it is always on
	screen rather than behind a hover, because that sentence changing is the whole
	mechanism for noticing that a change of stock changed what every job does.
	Twelve rows going from "Cuts through 4.00mm" to "13.00mm left below" is
	something you see; a tooltip is something you would have had to already
	suspect. Everything else is one line, so the list stays readable.
-->
<template>
	<div class="outliner">

		<div class="toolbar">
			<button type="button" title="Import SVG" @click="file?.importSvg()">
				<span class="material-icons">note_add</span>
			</button>
			<button type="button" title="Import reference image" @click="file?.importReference()">
				<span class="material-icons">add_photo_alternate</span>
			</button>
			<span class="gap"/>
			<button type="button" title="New tool" @click="newTool">
				<span class="material-icons">hardware</span>
			</button>
			<button type="button" title="New job" @click="newJob">
				<span class="material-icons">route</span>
			</button>
			<span class="gap"/>
			<button type="button" title="Delete" :disabled="deletable.length === 0" @click="removeSelected">
				<span class="material-icons">delete</span>
			</button>
		</div>

		<div ref="treeEl" class="tree" tabindex="0" @keydown="onKeyDown" @pointerdown="onPointerDown">
			<div
				v-for="(row, index) in rows" :key="row.id"
				class="row"
				:class="{
					selected: selectedIds.includes(row.id),
					active: activeId === row.id,
					dimmed: !row.visible,
					tall: detailOf(row) !== null,
					dropInto: drop?.kind === 'into' && drop?.overId === row.id,
					dropBefore: drop?.kind === 'before' && drop?.overId === row.id,
					dropAfter: drop?.kind === 'after' && drop?.overId === row.id,
				}"
				:data-index="index"
				:style="{ '--indent': `${6 + (row.depth * 14)}px` }"
			>
				<button v-if="row.hasChildren" type="button" class="twisty" @click.stop="toggle(row.id)">
					<span class="material-icons">{{ row.expanded ? 'expand_more' : 'chevron_right' }}</span>
				</button>
				<span v-else class="twisty"/>

				<span class="material-icons icon">{{ iconFor(row.node) }}</span>

				<span class="labels" :title="titleOf(row.id)">
					<input
						v-if="renamingId === row.id"
						ref="renameEl"
						class="rename"
						:value="row.node.name"
						@keydown.stop.enter="commitRename"
						@keydown.stop.esc="renamingId = null"
						@blur="commitRename"
					>
					<span v-else class="name" @dblclick.stop="startRename(row.id)">{{ row.node.name }}</span>
				</span>

				<!-- out of the flex flow, so it spans the whole row rather than
				     sharing the width with two toggle buttons and a badge. At the
				     depth a job sits at that is the difference between reading the
				     numbers and reading an ellipsis, and the numbers are the point -->
				<span v-if="detailOf(row) !== null" class="detail"
					:title="titleOf(row.id)">{{ detailOf(row) }}</span>

				<span v-if="worstOf(row.id) !== null" class="badge" :class="worstOf(row.id)"
					:title="messagesOf(row.id)">●</span>

				<button type="button" class="toggle" :title="row.node.visible ? 'Hide' : 'Show'"
					@click.stop="flip(row, 'visible')">
					<span class="material-icons">{{ row.node.visible ? 'visibility' : 'visibility_off' }}</span>
				</button>
				<button type="button" class="toggle" :title="row.node.locked ? 'Unlock' : 'Lock'"
					@click.stop="flip(row, 'locked')">
					<span class="material-icons">{{ row.node.locked ? 'lock' : 'lock_open' }}</span>
				</button>
			</div>
		</div>

	</div>
</template>

<script setup>

import { ref, shallowRef, computed, inject, nextTick } from 'vue';

import { NodeType, FolderRole, createNode } from '@core/project/nodes.js';
import { folderOf, childrenOf, ancestorOfType } from '@core/project/tree.js';
import { byNode, Level } from '@core/project/diagnostics.js';
import { setField, addNode, addSubtree, removeNode, moveNode } from '@core/project/commands.js';

import {
	flattenTree, resolveDrop, adjustedIndex, clickSelection, detailLine, detailTitle,
} from './outliner/rows.js';
import { iconFor } from './outliner/icons.js';

/** How far the pointer must move before a click becomes a drag. */
const DRAG_THRESHOLD = 4;

const store = inject('projectStore', null);
const file = inject('projectFile', null);

/** @type {import('vue').Ref} The scrolling tree, for hit-testing during a drag. */
const treeEl = ref(null);

/** @type {import('vue').Ref} The rename input, so it can be focused. */
const renameEl = ref(null);

/** Ids whose children are hidden. Collapsed rather than expanded — see rows.js. */
const collapsed = shallowRef(new Set());

/** Which node is being renamed, if any. */
const renamingId = ref(null);

/** Where the last plain click was, for shift-ranges. */
const anchorId = shallowRef(null);

/** Where a drag would land, or null when it would not. */
const drop = shallowRef(null);

/** The flattened tree. Reads `revision`, so it follows every commit. */
const rows = computed(() => {
	store.revision.value;
	return flattenTree(store.document, collapsed.value);
});

const selectedIds = computed(() => store.selection.value.ids);
const activeId = computed(() => store.selection.value.active);

/** Diagnostics grouped by node, recomputed with them. */
const diagnostics = computed(() => byNode(store.diagnostics.value));

/** What Delete would actually remove: never the project, never a fixed folder. */
const deletable = computed(() => selectedIds.value.filter((id) => {
	const node = store.document.nodes[id];
	return node !== undefined && node.type !== NodeType.PROJECT && node.type !== NodeType.FOLDER;
}));

/**
 * The second line of a row, or null when it has one line.
 *
 * @param {Object} row - the row
 * @returns {String|null} the detail line
 */
function detailOf(row) {
	return detailLine(row.node, diagnostics.value.get(row.id) ?? []);
}

/**
 * Every diagnostic on a node as full sentences, for the row's tooltip.
 *
 * The row shows a compact form of the depth; this is where the whole sentence
 * lives, along with anything else the node has to say.
 *
 * @param {String} id - the node
 * @returns {String|undefined} the tooltip, or nothing when there is none
 */
function titleOf(id) {
	return detailTitle(diagnostics.value.get(id) ?? []) || undefined;
}

/**
 * The worst diagnostic level on a node.
 *
 * @param {String} id - the node
 * @returns {String|null} `error`, `warning`, or null — info is the second line,
 *   not a badge, because a fact is not something to flag
 */
function worstOf(id) {

	const found = diagnostics.value.get(id) ?? [];

	if (found.some((d) => d.level === Level.ERROR))
		return Level.ERROR;

	return found.some((d) => d.level === Level.WARNING) ? Level.WARNING : null;
}

/**
 * Every diagnostic on a node, for the badge's tooltip.
 *
 * @param {String} id - the node
 * @returns {String} one per line
 */
function messagesOf(id) {
	return (diagnostics.value.get(id) ?? []).map((d) => d.message).join('\n');
}

/**
 * Shows or hides a node's children.
 *
 * @param {String} id - the node
 */
function toggle(id) {
	const next = new Set(collapsed.value);
	next.has(id) ? next.delete(id) : next.add(id);
	collapsed.value = next;
}

/**
 * Flips a node's own visible or locked flag.
 *
 * The node's OWN flag, not the inherited one: hiding a folder must not write
 * `false` into every child, or unhiding it would bring back things that were
 * hidden on purpose.
 *
 * @param {Object} row - the row
 * @param {String} field - `visible` or `locked`
 */
function flip(row, field) {
	store.dispatch(setField(store.document, row.id, field, !row.node[field], { coalesce: false }));
}

/**
 * Starts renaming a node in place.
 *
 * @param {String} id - the node
 */
async function startRename(id) {
	renamingId.value = id;
	await nextTick();
	const input = Array.isArray(renameEl.value) ? renameEl.value[0] : renameEl.value;
	input?.select();
}

/**
 * Applies a rename, if it changed anything.
 *
 * @param {Object} event - the input event
 */
function commitRename(event) {

	const id = renamingId.value;
	const value = event.target.value.trim();

	renamingId.value = null;

	if (id === null || value === '' || value === store.document.nodes[id]?.name)
		return;

	store.dispatch(setField(store.document, id, 'name', value, { coalesce: false }));
}

/** Adds an empty tool group. */
function newTool() {
	const jobs = folderOf(store.document, FolderRole.JOBS);
	store.dispatch(addNode(store.document, jobs.id, createNode(NodeType.TOOL, { name: 'Tool' })));
}

/**
 * Adds a job, making a tool for it when there is not one yet.
 *
 * The tool and the job go in as ONE command, because they are one thing the
 * user did. Undoing "new job" and being left with an empty tool group you did
 * not ask for is the kind of small wrongness that makes undo feel unreliable.
 */
function newJob() {

	const jobs = folderOf(store.document, FolderRole.JOBS);
	const tools = childrenOf(store.document, jobs.id).filter((n) => n.type === NodeType.TOOL);
	const chosen = ancestorOfType(store.document, activeId.value ?? '', NodeType.TOOL)
		?? (store.document.nodes[activeId.value]?.type === NodeType.TOOL
			? store.document.nodes[activeId.value]
			: tools.at(-1));

	if (chosen !== undefined && chosen !== null) {
		store.dispatch(addNode(store.document, chosen.id, createNode(NodeType.JOB, { name: 'Job' })));
		return;
	}

	const tool = createNode(NodeType.TOOL, { name: 'Tool' });
	const job = createNode(NodeType.JOB, { name: 'Job' });
	tool.children = [job.id];

	// the JOB is selected, not the tool it had to make to hold it -- the user
	// asked for a job, and the Inspector should be showing one
	store.dispatch(addSubtree(store.document, jobs.id, [tool, job],
		{ label: 'Add job', selectId: job.id }));
}

/** Removes everything selected that may be removed. */
function removeSelected() {
	for (const id of deletable.value)
		if (store.document.nodes[id] !== undefined)
			store.dispatch(removeNode(store.document, id));
}

/**
 * Keyboard shortcuts on the tree.
 *
 * @param {KeyboardEvent} event - the key
 */
function onKeyDown(event) {

	if (renamingId.value !== null)
		return;

	if (event.key === 'Delete' || event.key === 'Backspace') {
		event.preventDefault();
		removeSelected();
	}

	if (event.key === 'F2' && activeId.value !== null) {
		event.preventDefault();
		startRename(activeId.value);
	}
}

/**
 * Begins a click or a drag on a row.
 *
 * Selection happens on pointer DOWN, the way every tree does, so dragging
 * something already selected does not first select only it.
 *
 * @param {PointerEvent} event - the pointer
 */
function onPointerDown(event) {

	const element = event.target.closest?.('.row');

	if (element === null || element === undefined || event.button !== 0)
		return;

	const index = Number(element.dataset.index);
	const row = rows.value[index];

	if (row === undefined)
		return;

	if (selectedIds.value.includes(row.id) === false || event.ctrlKey || event.metaKey || event.shiftKey) {

		const result = clickSelection({
			rows: rows.value,
			selected: selectedIds.value,
			anchorId: anchorId.value,
			id: row.id,
			toggle: event.ctrlKey || event.metaKey,
			range: event.shiftKey,
		});

		anchorId.value = result.anchorId;
		store.select(result.ids, { active: result.active });
	}

	startDrag(event, row);
}

/**
 * Watches for the pointer to move far enough to be a drag.
 *
 * @param {PointerEvent} down - the pointerdown that started it
 * @param {Object} row - the row under it
 */
function startDrag(down, row) {

	let dragging = false;

	/**
	 * Tracks the pointer.
	 *
	 * @param {PointerEvent} event - the move
	 */
	const onMove = (event) => {

		if (dragging === false) {

			if (Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < DRAG_THRESHOLD)
				return;

			dragging = true;
		}

		drop.value = hitTest(event, row.id);
	};

	/** Finishes, applying the drop if there is one. */
	const onUp = () => {

		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);

		const target = drop.value;
		drop.value = null;

		if (dragging === false || target === null)
			return;

		store.dispatch(moveNode(store.document, row.id, target.parentId,
			adjustedIndex(store.document, row.id, target)));
	};

	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', onUp);
}

/**
 * Works out where the pointer currently is over the tree.
 *
 * `elementFromPoint` rather than the event's target, because the pointer
 * listeners are on the window during a drag and the target is wherever the drag
 * began.
 *
 * @param {PointerEvent} event - the move
 * @param {String} dragId - what is being dragged
 * @returns {Object|null} what `resolveDrop` said
 */
function hitTest(event, dragId) {

	const element = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.row');

	if (element == null || treeEl.value?.contains(element) === false)
		return null;

	const box = element.getBoundingClientRect();

	return resolveDrop({
		document: store.document,
		rows: rows.value,
		dragId,
		overIndex: Number(element.dataset.index),
		fraction: (event.clientY - box.top) / box.height,
	});
}

</script>

<style scoped>

	.outliner {
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		height: 100%;
		background: var(--gg-surface);
		color: var(--gg-text);
		font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace;
		overflow: hidden;
	}

	/* ---------------------------------------------------------- toolbar */

	.toolbar {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 4px 6px;
		border-bottom: 1px solid var(--gg-border);
		background: var(--gg-surface-raised);
	}

	.toolbar button {
		display: flex;
		align-items: center;
		padding: 4px;
		border: 0;
		border-radius: 3px;
		background: transparent;
		color: var(--gg-text-muted);
		cursor: pointer;
	}

	.toolbar button:hover:not(:disabled) {
		background: var(--gg-surface-sunken);
		color: var(--gg-text);
	}

	.toolbar button:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.toolbar .material-icons {
		font-size: 17px;
	}

	.gap {
		width: 8px;
	}

	/* ------------------------------------------------------------- tree */

	.tree {
		flex: 1;
		padding: 3px 0;
		outline: none;
		overflow: auto;
		user-select: none;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 4px;
		position: relative;
		height: 22px;
		padding-right: 4px;
		padding-left: var(--indent);
		cursor: default;
	}

	/* jobs are two lines: the name, and the depth under it */
	.row.tall {
		align-items: flex-start;
		height: 34px;
		padding-top: 3px;
	}

	.row:hover {
		background: var(--gg-surface-sunken);
	}

	.row.selected {
		background: color-mix(in srgb, var(--gg-accent) 22%, transparent);
	}

	.row.active {
		background: color-mix(in srgb, var(--gg-accent) 34%, transparent);
	}

	.row.dimmed .labels,
	.row.dimmed .icon {
		opacity: 0.4;
	}

	.twisty {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 14px;
		height: 14px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--gg-text-muted);
		cursor: pointer;
	}

	.twisty .material-icons {
		font-size: 14px;
	}

	.icon {
		flex: 0 0 auto;
		color: var(--gg-text-muted);
		font-size: 15px;
	}

	.labels {
		display: flex;
		align-items: center;
		flex: 1;
		min-width: 0;
		height: 16px;
	}

	.name {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	/* left is the indent plus the twisty and the icon, so it lines up under the
	   name; right is the edge of the row, so it gets every pixel there is */
	.detail {
		position: absolute;
		left: calc(var(--indent) + 33px);
		right: 6px;
		bottom: 3px;
		color: var(--gg-text-muted);
		font-size: 11px;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		pointer-events: none;
	}

	.rename {
		width: 100%;
		padding: 1px 3px;
		border: 1px solid var(--gg-accent);
		border-radius: 2px;
		background: var(--gg-surface-sunken);
		color: var(--gg-text);
		font: inherit;
		outline: none;
	}

	.badge {
		flex: 0 0 auto;
		font-size: 10px;
	}

	.badge.warning {
		color: var(--gg-warning);
	}

	.badge.error {
		color: var(--gg-danger);
	}

	.toggle {
		display: flex;
		align-items: center;
		flex: 0 0 auto;
		padding: 0 1px;
		border: 0;
		background: transparent;
		color: var(--gg-text-muted);
		opacity: 0.5;
		cursor: pointer;
	}

	.row:hover .toggle,
	.toggle:focus-visible {
		opacity: 1;
	}

	.toggle .material-icons {
		font-size: 14px;
	}

	/* ------------------------------------------------------- drop hints */

	.row.dropInto {
		outline: 1px solid var(--gg-accent);
		outline-offset: -1px;
	}

	.row.dropBefore::before,
	.row.dropAfter::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		height: 2px;
		background: var(--gg-accent);
	}

	.row.dropBefore::before {
		top: -1px;
	}

	.row.dropAfter::after {
		bottom: -1px;
	}

</style>
