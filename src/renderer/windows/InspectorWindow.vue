<!--
	@file InspectorWindow.vue
	@description Properties of whatever is selected.

	Scratch-built rather than a form library, because the thing being edited is
	described by a table the application already owns — the FieldSpecs in core —
	and a library would want that described a second time in its own vocabulary.
	The layout is `inspector/layout.js`, the controls are `inspector/FieldRow.vue`,
	and this file is the arrangement and the dispatching.

	Every edit goes through a command, so every edit is undoable and every edit
	regenerates the right G-code later. There is no path from a control to the
	document that does not pass through the store.
-->
<template>
	<div class="inspector">

		<div class="head">
			<span class="title">{{ layout.title }}</span>
			<span v-if="layout.type !== null" class="kind">{{ typeLabel }}</span>
		</div>

		<div v-if="layout.groups.length === 0" class="empty">
			Select something in the outliner.
		</div>

		<div v-else class="body">

			<template v-for="group in layout.groups" :key="group.name">
				<div class="group">{{ group.name }}</div>
				<FieldRow
					v-for="field in group.fields"
					:key="field.field"
					:field="field"
					:node-type="layout.nodes[0].type"
					:unit="unit"
					:relevant="relevantOf(field.field)"
					:reference-names="namesOf(field)"
					@commit="(value) => apply(field.field, value)"
					@reset="() => clear(field.field)"
				/>
			</template>

			<div v-if="actions.length > 0" class="group">Actions</div>
			<div v-if="actions.length > 0" class="actions">
				<button v-for="action in actions" :key="action.label" type="button"
					:title="action.title" @click="action.run()">{{ action.label }}</button>
			</div>

		</div>

	</div>
</template>

<script setup>

import { computed, inject } from 'vue';

import { NodeType, createNode } from '@core/project/nodes.js';
import { resolvedValues } from '@core/project/inherit.js';
import { parentOf, ancestorOfType, childrenOf, folderOf } from '@core/project/tree.js';
import { setField, clearOverride, addNode, addSubtree, setReferences } from '@core/project/commands.js';
import { arcLengths } from '@core/cam/tabs.js';

import { inspectorLayout, isRelevant, MIXED, TYPE_LABEL } from './inspector/layout.js';
import FieldRow from './inspector/FieldRow.vue';

const store = inject('projectStore', null);
const settings = inject('appSettings', null);

/** The display unit, from the application settings. */
const unit = computed(() => settings?.units ?? 'mm');

/** What to draw, for whatever is selected. */
const layout = computed(() => {
	store.revision.value;
	return inspectorLayout(store.document, store.selection.value.ids);
});

/** What kind of thing is selected, in words rather than in identifiers. */
const typeLabel = computed(() => TYPE_LABEL[layout.value.type] ?? layout.value.type);

/** The active node's resolved values, for deciding what applies right now. */
const values = computed(() => {
	const node = layout.value.nodes[0];
	return node === undefined ? {} : resolvedValues(store.document, node.id);
});

/**
 * Whether a field has any effect given the other settings.
 *
 * @param {String} field - the field name
 * @returns {Boolean} false when it is drawn but inert
 */
function relevantOf(field) {
	return isRelevant(layout.value.nodes[0], field, values.value);
}

/**
 * The names behind a reference list, since an id means nothing on screen.
 *
 * @param {Object} field - an InspectorField
 * @returns {String[]} the names
 */
function namesOf(field) {

	if (field.spec.kind !== 'references' || field.value === MIXED)
		return [];

	return field.value.map((id) => store.document.nodes[id]?.name ?? '(missing)');
}

/**
 * Applies an edit to every selected node.
 *
 * One command per node rather than one for the batch: they are separate edits
 * to separate nodes, and undoing "set the feed on four jobs" one job at a time
 * is closer to what happened than one entry that moves four things at once.
 * Coalescing keeps a drag from filling the stack either way.
 *
 * @param {String} field - the field name
 * @param {*} value - the new value
 */
function apply(field, value) {
	for (const node of layout.value.nodes)
		store.dispatch(setField(store.document, node.id, field, value));
}

/**
 * Puts a field back on its inherited value, for every selected node.
 *
 * @param {String} field - the field name
 */
function clear(field) {
	for (const node of layout.value.nodes)
		if (node[field] !== undefined)
			store.dispatch(clearOverride(store.document, node.id, field));
}

/** What can be done to the current selection, beyond editing its fields. */
const actions = computed(() => {

	store.revision.value;

	const nodes = layout.value.nodes;
	const found = [];

	if (nodes.length > 0 && nodes.every((node) => node.type === NodeType.SVG_PATH)) {

		found.push({
			label: nodes.length === 1 ? 'Create job from path' : `Create job from ${nodes.length} paths`,
			title: 'Make a job that cuts these paths, in the last tool group',
			run: () => createJobFromPaths(nodes),
		});

		found.push({
			label: 'Use as work material',
			title: 'Treat this outline as the shape of the stock',
			run: () => useAsWorkMaterial(nodes),
		});
	}

	if (nodes.length === 1 && nodes[0].type === NodeType.JOB)
		found.push({
			label: 'Add tab',
			title: 'Place a break in the cut, halfway along',
			run: () => addTab(nodes[0]),
		});

	return found;
});

/**
 * Makes a job that cuts the selected paths.
 *
 * Into the last tool group, or into a new one when there is none — and the tool
 * and job go in as one command, for the same reason the outliner's New Job does.
 *
 * The operation is chosen from the paths themselves: an open path has no inside
 * or outside, so offering `outside` for one would be offering something the
 * geometry cannot do. Centre is the honest default either way, and it is what
 * D17 describes — the tool follows the line you drew.
 *
 * @param {Object[]} paths - the selected SvgPath nodes
 */
function createJobFromPaths(paths) {

	const jobs = folderOf(store.document, 'jobs');
	const tools = childrenOf(store.document, jobs.id).filter((n) => n.type === NodeType.TOOL);
	const name = paths.length === 1 ? paths[0].name : `${paths.length} paths`;
	const job = createNode(NodeType.JOB, { name, paths: paths.map((path) => path.id) });

	if (tools.length > 0) {
		store.dispatch(addNode(store.document, tools.at(-1).id, job));
		return;
	}

	const tool = createNode(NodeType.TOOL, { name: 'Tool' });
	tool.children = [job.id];

	store.dispatch(addSubtree(store.document, jobs.id, [tool, job],
		{ label: 'Create job from path', selectId: job.id }));
}

/**
 * Points the project's work material at the selected paths.
 *
 * @param {Object[]} paths - the selected SvgPath nodes
 */
function useAsWorkMaterial(paths) {

	const existing = childrenOf(store.document, store.document.root)
		.find((node) => node.type === NodeType.WORK_MATERIAL);

	if (existing !== undefined) {
		store.dispatch(setReferences(store.document, existing.id, 'paths', paths.map((p) => p.id)));
		return;
	}

	store.dispatch(addNode(store.document, store.document.root,
		createNode(NodeType.WORK_MATERIAL, { name: 'Stock', paths: paths.map((p) => p.id) })));
}

/**
 * Adds a tab halfway along the job's first path.
 *
 * Halfway is a starting point, not a decision — tabs are placed by hand and
 * dragged along the path (D17), and this only has to put one somewhere you can
 * see it. Its length and depth come from the project defaults, inherited rather
 * than copied, so retuning a run of tabs is one number.
 *
 * @param {Object} job - the job node
 */
function addTab(job) {

	const geometry = store.project.geometry[store.document.nodes[job.paths?.[0]]?.geometry];
	const points = geometry?.subPaths?.[0]?.segments?.map((segment) => segment.to) ?? [];
	const middle = points.length > 1 ? arcLengths(points).at(-1) / 2 : 0;

	store.dispatch(addNode(store.document, job.id,
		createNode(NodeType.TAB, { name: 'Tab', position: middle })));
}

</script>

<style scoped>

	.inspector {
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		height: 100%;
		background: var(--gg-surface);
		color: var(--gg-text);
		font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace;
		overflow: hidden;
	}

	.head {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--gg-border);
		background: var(--gg-surface-raised);
	}

	.title {
		font-weight: 600;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.kind {
		color: var(--gg-text-muted);
		font-size: 11px;
	}

	.empty {
		padding: 14px 10px;
		color: var(--gg-text-muted);
	}

	.body {
		flex: 1;
		padding-bottom: 10px;
		overflow: auto;
	}

	.group {
		position: sticky;
		top: 0;
		z-index: 1;
		margin-top: 6px;
		padding: 4px 8px;
		background: var(--gg-surface-sunken);
		color: var(--gg-accent);
		font-size: 11px;
		font-weight: 600;
	}

	.actions {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px 8px;
	}

	.actions button {
		padding: 5px 8px;
		border: 1px solid var(--gg-border);
		border-radius: 3px;
		background: var(--gg-surface-raised);
		color: var(--gg-text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.actions button:hover {
		border-color: var(--gg-accent);
		color: var(--gg-accent);
	}

</style>
