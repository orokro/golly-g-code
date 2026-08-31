<!--
	@file WorkspaceWindow.vue
	@description The 2D view: the drawing, the grid, and how wide the cut is.

	SVG rather than canvas, because everything here is a shape that wants to be
	hit-tested and selected, and the browser already does that better than a
	redrawn canvas plus a spatial index would.

	Three rules from plan.md that shape the whole file:

	ONE `<path>` PER OBJECT, never one per segment. Fifty thousand sibling
	elements is a browser that stops responding; one element with a fifty-
	thousand-command `d` is fine. The `d` is built when the geometry changes and
	never when the view does — pan and zoom are a transform on the wrapping `<g>`.

	`vector-effect: non-scaling-stroke` on the drawing, so a hairline stays a
	hairline at any zoom. Deliberately NOT on the kerf, which is a real physical
	width and has to scale with everything else — that is the entire point of it.

	THE KERF IS THE ARTWORK (D17). The wide translucent band is not decoration:
	it is the material the bit will actually remove, and seeing where it swallows
	a detail is what the view is for.
-->
<template>
	<div ref="body" class="workspace">

		<svg ref="svgEl" class="canvas" @wheel.prevent="onWheel" @pointerdown="onPointerDown"
			@dblclick="zoomToFit">

			<defs>
				<pattern :id="gridId" :width="cell" :height="cell" patternUnits="userSpaceOnUse"
					:x="view.x" :y="view.y">
					<path :d="`M${cell} 0 L0 0 0 ${cell}`" fill="none"
						stroke="var(--gg-border)" stroke-width="1"/>
				</pattern>
			</defs>

			<rect v-if="showGrid" class="grid" width="100%" height="100%" :fill="`url(#${gridId})`"/>

			<g :transform="transform">

				<!-- the bed, so the drawing has somewhere to sit -->
				<rect class="bed" x="0" :y="-machine.height" :width="machine.width" :height="machine.height"
					fill="none" stroke="var(--gg-text-muted)" stroke-width="1"
					vector-effect="non-scaling-stroke" transform="scale(1 -1)"/>

				<!-- the kerf: what the bit actually removes. Scales, on purpose -->
				<path v-for="cut in kerfs" :key="`k${cut.id}`" class="kerf" :d="cut.d"
					fill="none" :stroke-width="cut.width" stroke="var(--gg-cut)"
					stroke-linecap="round" stroke-linejoin="round"/>

				<!-- the toolpath itself: where the CENTRE of the bit goes -->
				<path v-for="cut in kerfs" :key="`c${cut.id}`" class="centreline" :d="cut.d"
					fill="none" stroke-width="1" vector-effect="non-scaling-stroke"/>

				<!-- the drawing itself, a hairline at any zoom -->
				<path v-for="shape in shapes" :key="shape.id" class="shape" :d="shape.d"
					:class="{ selected: selectedIds.includes(shape.id) }"
					fill="none" stroke-width="1" vector-effect="non-scaling-stroke"/>

				<!-- a fat transparent stroke, so a hairline is still clickable -->
				<path v-for="shape in shapes" :key="`h${shape.id}`" class="hit" :d="shape.d"
					:class="{ locked: shape.locked }" fill="none" stroke="transparent"
					stroke-width="8" vector-effect="non-scaling-stroke"
					@pointerdown.stop="onPickShape($event, shape)"/>

				<!-- work zero: everything emitted is measured from here -->
				<g class="puck" :transform="`translate(${machine.zero.x} ${machine.zero.y})`">
					<circle r="7" :stroke-width="1.5" vector-effect="non-scaling-stroke"
						fill="none" stroke="var(--gg-accent)"/>
					<path d="M-11 0 H11 M0 -11 V11" :stroke-width="1.5"
						vector-effect="non-scaling-stroke" stroke="var(--gg-accent)"/>
				</g>

			</g>

			<text class="scaleLabel" x="8" :y="height - 8">
				{{ cellLabel }} grid · {{ Math.round(view.scale * 100) }}%
			</text>

		</svg>

		<div v-if="shapes.length === 0" class="empty">
			Import an SVG to see it here.
		</div>

	</div>
</template>

<script setup>

import { ref, shallowRef, computed, inject, watch } from 'vue';

import { NodeType } from '@core/project/nodes.js';
import { isVisible, isLocked } from '@core/project/tree.js';
import { resolvedValues } from '@core/project/inherit.js';

import { useResize } from '../composables/useResize.js';
import { useToolpaths } from '../composables/useToolpaths.js';
import { pathData, polylineData, boundsOf, unionBounds, padBounds } from './workspace/geometry.js';
import {
	createView, viewTransform, toWorld, panBy, zoomAt, fitBounds, gridSpacing,
} from './workspace/view.js';

/** How much one wheel notch zooms. */
const WHEEL_STEP = 1.12;

const store = inject('projectStore', null);
const settings = inject('appSettings', null);

/** @type {import('vue').Ref} The window body, for its size. */
const body = ref(null);

/** @type {import('vue').Ref} The svg element, for pointer coordinates. */
const svgEl = ref(null);

/** The pan and zoom. Replaced, never mutated — see renderer/CONVENTIONS.md. */
const view = shallowRef(createView());

/** Unique per instance, so two Workspace windows do not share one pattern. */
const gridId = `grid-${Math.random().toString(36).slice(2, 9)}`;

/**
 * The window's size in CSS pixels.
 *
 * `useResize` takes a CALLBACK and returns its watcher; it does not hand back a
 * ref. Destructuring a `size` off it gave undefined, every computed that read
 * `size.value` threw, and Vue swallowed those as render errors — so the view
 * came up blank with the grid drawn and nothing else, and no page error at all.
 * Found by looking at it, which is the only thing that could have.
 */
const size = shallowRef({ width: 0, height: 0 });

useResize(body, (measured) => { size.value = measured; });

const height = computed(() => size.value.height || 0);
const showGrid = computed(() => settings?.showGrid !== false);

const transform = computed(() => viewTransform(view.value));
const selectedIds = computed(() => store.selection.value.ids);

/**
 * The toolpaths, regenerated when the document settles.
 *
 * Injected, because the app makes one set for everybody. The fallback is not
 * defensive padding: this window is mounted on its own in tests and in the
 * browser verification harness, where there is no App above it to provide one.
 */
const { toolpaths } = inject('toolpaths', null) ?? useToolpaths({ store });

/** The bed, from the project's own settings. */
const machine = computed(() => {
	store.revision.value;
	const project = resolvedValues(store.document, store.document.root);
	return {
		width: project.workspaceWidth,
		height: project.workspaceHeight,
		zero: project.workZero,
	};
});

/**
 * Every visible path in the drawing, as one `<path>` each.
 *
 * Keyed on `revision`, so the `d` strings are rebuilt when the document changes
 * and NOT when the view does. That is the difference between panning a large
 * drawing smoothly and re-serialising a megabyte of path data per mouse move.
 */
const shapes = computed(() => {

	store.revision.value;

	const found = [];

	for (const node of Object.values(store.document.nodes)) {

		if (node.type !== NodeType.SVG_PATH || isVisible(store.document, node.id) === false)
			continue;

		const geometry = store.project.geometry[node.geometry];

		if (geometry === undefined)
			continue;

		found.push({
			id: node.id,
			d: pathData(geometry.subPaths),
			bounds: boundsOf(geometry.subPaths),
			locked: isLocked(store.document, node.id),
		});
	}

	return found;
});

/**
 * The kerf for every job, at its tool's real width.
 *
 * Every operation now, not just centre: the toolpath comes from `core/cam`
 * through `useToolpaths`, so an inside cut is drawn where an inside cut actually
 * goes. The band is the toolpath stroked at the tool's diameter with round caps
 * and joins, which is exactly the material a round cutter removes travelling
 * along it — the browser draws that for free and correctly at any zoom.
 *
 * Drawn from POINTS rather than from the source's `d`, because a toolpath is
 * not the drawing: it is the drawing offset, cut into passes and rearranged, and
 * the whole point of showing it is that it differs.
 */
const kerfs = computed(() => {

	const found = [];

	for (const entry of toolpaths.value) {

		if (isVisible(store.document, entry.jobId) === false)
			continue;

		const width = store.document.nodes[entry.toolId]?.diameter
			?? resolvedValues(store.document, entry.toolId).diameter;

		entry.paths.forEach((path, index) => {
			found.push({ id: `${entry.jobId}-${index}`, d: polylineData(path), width });
		});
	}

	return found;
});

/** The grid cell, in millimetres, for the current zoom. */
const cell = computed(() => gridSpacing(view.value.scale) * view.value.scale);

/** What the grid cell measures, in words. */
const cellLabel = computed(() => `${gridSpacing(view.value.scale)}mm`);

/**
 * Fits everything worth looking at into the window.
 *
 * The drawing if there is one, the bed if there is not — an empty project
 * showing a view of nothing at 100% is a window you have to fight before you
 * can use it.
 */
function zoomToFit() {

	const drawing = unionBounds(shapes.value.map((shape) => shape.bounds));
	const bed = { minX: 0, minY: 0, maxX: machine.value.width, maxY: machine.value.height };

	view.value = fitBounds(padBounds(drawing ?? bed, 5), size.value);
}

/**
 * Zooms about the pointer.
 *
 * @param {WheelEvent} event - the wheel
 */
function onWheel(event) {

	const at = local(event);

	view.value = zoomAt(view.value, event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, at.x, at.y);
}

/**
 * Starts a pan, or clears the selection.
 *
 * Middle button or a drag on empty space pans; a click on empty space that did
 * not move selects nothing, which is how you get back to the project's own
 * settings without hunting for its row in the outliner.
 *
 * @param {PointerEvent} event - the pointer
 */
function onPointerDown(event) {

	if (event.button !== 0 && event.button !== 1)
		return;

	const from = { x: event.clientX, y: event.clientY };
	const start = view.value;
	let moved = false;

	/**
	 * Pans with the pointer.
	 *
	 * @param {PointerEvent} move - the move
	 */
	const onMove = (move) => {

		const dx = move.clientX - from.x;
		const dy = move.clientY - from.y;

		if (moved === false && Math.hypot(dx, dy) < 3)
			return;

		moved = true;
		view.value = panBy(start, dx, dy);
	};

	/** Finishes. */
	const onUp = () => {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		if (moved === false && event.button === 0)
			store.select([]);
	};

	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', onUp);
}

/**
 * Selects the shape under the pointer.
 *
 * Locked shapes are not hit-testable at all (`pointer-events: none` in the
 * stylesheet), so this never sees one — locking something means it stops being
 * in the way, which is the whole reason to lock it.
 *
 * @param {PointerEvent} event - the pointer
 * @param {Object} shape - the shape picked
 */
function onPickShape(event, shape) {

	const already = selectedIds.value.includes(shape.id);

	if (event.ctrlKey || event.metaKey)
		store.select(already
			? selectedIds.value.filter((id) => id !== shape.id)
			: [...selectedIds.value, shape.id]);
	else
		store.select([shape.id]);
}

/**
 * A pointer event's position within the svg.
 *
 * @param {PointerEvent} event - the pointer
 * @returns {Object} `{ x, y }` in pixels from the element's top left
 */
function local(event) {

	const box = svgEl.value?.getBoundingClientRect();

	return box === undefined
		? { x: event.clientX, y: event.clientY }
		: { x: event.clientX - box.left, y: event.clientY - box.top };
}

// Fit once there is a window to fit into, and again when the first drawing
// arrives. An import that lands off screen looks exactly like an import that
// failed, and with Y up the drawing sits ABOVE an unfitted view rather than
// merely beside it, so there is not even an edge of it showing.
let fitted = false;

watch(
	() => [size.value.width > 0, shapes.value.length > 0],
	([hasRoom, hasDrawing]) => {

		if (hasRoom === false)
			return;

		if (fitted === false || hasDrawing) {
			fitted = true;
			zoomToFit();
		}
	},
	{ immediate: true, flush: 'post' },
);

defineExpose({ view, zoomToFit, toWorld: (x, y) => toWorld(view.value, x, y) });

</script>

<style scoped>

	.workspace {
		position: relative;
		height: 100%;
		background: var(--gg-background);
		overflow: hidden;
	}

	.canvas {
		display: block;
		width: 100%;
		height: 100%;
		cursor: grab;
		touch-action: none;
	}

	.canvas:active {
		cursor: grabbing;
	}

	.grid {
		pointer-events: none;
	}

	.bed {
		opacity: 0.35;
		pointer-events: none;
	}

	/* translucent, because it is material about to be removed rather than a
	   drawn line, and because overlapping passes should read as overlapping */
	.kerf {
		opacity: 0.28;
		pointer-events: none;
	}

	.shape {
		stroke: var(--gg-text-muted);
		pointer-events: none;
	}

	/* where the centre of the bit goes. Dashed, so it reads as a path rather
	   than as another edge of the drawing */
	.centreline {
		stroke: var(--gg-cut);
		stroke-dasharray: 4 3;
		opacity: 0.9;
		pointer-events: none;
	}

	.shape.selected {
		stroke: var(--gg-accent);
		stroke-width: 2;
	}

	.hit {
		cursor: pointer;
	}

	/* locking something means it stops being in the way */
	.hit.locked {
		pointer-events: none;
	}

	.puck {
		pointer-events: none;
	}

	.scaleLabel {
		fill: var(--gg-text-muted);
		font: 11px ui-monospace, Menlo, Consolas, monospace;
		pointer-events: none;
	}

	.empty {
		position: absolute;
		top: 50%;
		left: 0;
		right: 0;
		color: var(--gg-text-muted);
		font: 12px ui-monospace, Menlo, Consolas, monospace;
		text-align: center;
		pointer-events: none;
	}

</style>
