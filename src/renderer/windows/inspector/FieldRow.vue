<!--
	@file FieldRow.vue
	@description One label-and-control row in the Inspector.

	Draws itself from the FieldSpec rather than from a per-field template, which
	is what makes adding a setting a one-line change to the table in core rather
	than a new component. The whole control set is here on purpose: eight small
	branches in one file are easier to keep consistent than eight files that
	slowly stop agreeing about padding.

	Two states worth understanding:

	INHERITED — the value came from an ancestor, so the row is drawn in the
	distinct state and carries a reset button. The reset DELETES the node's own
	value; it does not write the ancestor's current one in. Those look identical
	the moment you press it and behave completely differently the next time the
	tool is corrected.

	MIXED — several nodes are selected and they disagree. The control shows
	nothing rather than the first one's value, and typing into it sets all of them.
-->
<template>
	<div class="row" :class="{ inherited: isInherited, dimmed: !relevant, invalid: error !== null }">

		<label class="label" :title="spec.desc">
			{{ spec.label }}
			<button v-if="field.overridden" type="button" class="reset"
				title="Use the inherited value again" @click="$emit('reset')">
				<span class="material-icons">undo</span>
			</button>
		</label>

		<div class="control">

			<template v-if="field.readOnly">
				<span class="readOnly">{{ readOnlyText }}</span>
			</template>

			<template v-else-if="spec.kind === 'boolean'">
				<input type="checkbox" :checked="field.value === true"
					:indeterminate="isMixed" @change="commit($event.target.checked)">
			</template>

			<template v-else-if="spec.kind === 'select'">
				<select :value="isMixed ? '' : field.value" @change="commit($event.target.value)">
					<option v-if="isMixed" value="" disabled>—</option>
					<option v-for="option in spec.options" :key="option" :value="option">{{ option }}</option>
				</select>
			</template>

			<template v-else-if="spec.kind === 'vector2'">
				<input class="num" type="number" :step="step" :value="part('x')"
					:placeholder="isMixed ? '—' : ''" @change="commitPart('x', $event.target.value)">
				<input class="num" type="number" :step="step" :value="part('y')"
					:placeholder="isMixed ? '—' : ''" @change="commitPart('y', $event.target.value)">
				<span class="unit">{{ unitText }}</span>
			</template>

			<template v-else-if="spec.kind === 'references'">
				<span class="readOnly">{{ referenceText }}</span>
			</template>

			<template v-else-if="spec.kind === 'number'">
				<input v-if="spec.quantity === 'fraction'" class="slider" type="range"
					:min="displayMin" :max="displayMax" :step="step"
					:value="isMixed ? displayMin : shown" @input="commit($event.target.value)">
				<input class="num" type="number" :step="step" :min="displayMin" :max="displayMax"
					:value="isMixed ? '' : shown" :placeholder="isMixed ? '—' : ''"
					@change="commit($event.target.value)">
				<span class="unit">{{ unitText }}</span>
			</template>

			<template v-else>
				<input class="text" type="text" :value="isMixed ? '' : field.value"
					:placeholder="isMixed ? '—' : ''" @change="commit($event.target.value)">
			</template>

			<span v-if="error !== null" class="error">{{ error }}</span>

		</div>

	</div>
</template>

<script setup>

import { ref, computed } from 'vue';

import { validateValue } from '@core/project/schema.js';
import { Source } from '@core/project/inherit.js';

import { MIXED } from './layout.js';
import { toDisplay, fromDisplay, formatValue, displayStep, unitLabel } from './format.js';

const props = defineProps({
	/** The field, from `inspectorLayout`. */
	field: { type: Object, required: true },

	/** The node type these values belong to, for validation. */
	nodeType: { type: String, required: true },

	/** The display unit, one of core's `Unit`. */
	unit: { type: String, default: 'mm' },

	/** False when the field has no effect given the other settings. */
	relevant: { type: Boolean, default: true },

	/** Names for a reference list, since ids mean nothing on screen. */
	referenceNames: { type: Array, default: () => [] },
});

const emit = defineEmits(['commit', 'reset']);

/** What the last attempted edit was rejected for, or null. */
const error = ref(null);

const spec = computed(() => props.field.spec);
const isMixed = computed(() => props.field.value === MIXED);
const isInherited = computed(() => props.field.source === Source.INHERITED);

const step = computed(() => displayStep(spec.value, props.unit));
const shown = computed(() => formatValue(props.field.value, spec.value.quantity, props.unit));
const unitText = computed(() => unitLabel(spec.value.quantity, props.unit));

const displayMin = computed(() => (spec.value.min === undefined
	? undefined
	: toDisplay(spec.value.min, spec.value.quantity, props.unit)));

const displayMax = computed(() => (spec.value.max === undefined
	? undefined
	: toDisplay(spec.value.max, spec.value.quantity, props.unit)));

/** A read-only field's text. */
const readOnlyText = computed(() => {

	if (isMixed.value)
		return '—';

	if (spec.value.kind === 'boolean')
		return props.field.value ? 'yes' : 'no';

	if (spec.value.kind === 'references')
		return referenceText.value;

	return String(props.field.value ?? '') || '—';
});

/** A reference list, by name rather than by id. */
const referenceText = computed(() => {

	if (isMixed.value)
		return '—';

	return props.referenceNames.length === 0
		? 'none'
		: props.referenceNames.join(', ');
});

/**
 * One component of a vector, as shown.
 *
 * @param {String} axis - `x` or `y`
 * @returns {String} the number for the input
 */
function part(axis) {
	return isMixed.value ? '' : formatValue(props.field.value?.[axis], spec.value.quantity, props.unit);
}

/**
 * Validates a proposed value and passes it up, or refuses it here.
 *
 * Blocked at the row rather than swallowed by the command, so the message lands
 * next to the box that caused it. An invalid value never becomes a command, so
 * it never enters the undo stack and can never be reached again by undoing.
 *
 * @param {*} raw - what the control produced
 */
function commit(raw) {

	const value = coerce(raw);
	const issues = validateValue(props.nodeType, props.field.field, value);

	error.value = issues.length > 0 ? issues[0] : null;

	if (issues.length === 0)
		emit('commit', value);
}

/**
 * Commits one component of a vector, keeping the other.
 *
 * @param {String} axis - `x` or `y`
 * @param {String} raw - what the input produced
 */
function commitPart(axis, raw) {

	const current = isMixed.value ? { x: 0, y: 0 } : props.field.value;
	const next = { ...current, [axis]: fromDisplay(Number(raw), spec.value.quantity, props.unit) };

	commit(next);
}

/**
 * Turns what a control produced into what the field stores.
 *
 * @param {*} raw - the control's value
 * @returns {*} a value of the field's own kind
 */
function coerce(raw) {

	if (typeof raw === 'object')
		return raw;

	if (spec.value.kind === 'number')
		return fromDisplay(Number(raw), spec.value.quantity, props.unit);

	return raw;
}

</script>

<style scoped>

	.row {
		display: grid;
		grid-template-columns: 40% 1fr;
		align-items: start;
		gap: 8px;
		padding: 3px 8px;
	}

	.label {
		display: flex;
		align-items: center;
		gap: 4px;
		padding-top: 3px;
		color: var(--gg-text-muted);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		cursor: default;
	}

	/* the distinct state for a value that is not this node's own */
	.row.inherited .label {
		color: var(--gg-warning);
	}

	.row.dimmed {
		opacity: 0.45;
	}

	.reset {
		display: flex;
		align-items: center;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
	}

	.reset .material-icons {
		font-size: 13px;
	}

	.control {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
	}

	input,
	select {
		min-width: 0;
		padding: 2px 4px;
		border: 1px solid var(--gg-border);
		border-radius: 3px;
		background: var(--gg-surface-sunken);
		color: var(--gg-text);
		font: inherit;
	}

	input:focus,
	select:focus {
		border-color: var(--gg-accent);
		outline: none;
	}

	.row.invalid input,
	.row.invalid select {
		border-color: var(--gg-danger);
	}

	.num {
		flex: 1 1 0;
		width: 100%;
		text-align: right;
	}

	.text,
	select {
		flex: 1;
		width: 100%;
	}

	.slider {
		flex: 1 1 60px;
		min-width: 40px;
		padding: 0;
		border: 0;
		background: transparent;
		accent-color: var(--gg-accent);
	}

	input[type="checkbox"] {
		width: 13px;
		height: 13px;
		accent-color: var(--gg-accent);
	}

	.unit {
		flex: 0 0 auto;
		width: 44px;
		color: var(--gg-text-muted);
		font-size: 11px;
	}

	.readOnly {
		color: var(--gg-text-muted);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.error {
		flex: 1 0 100%;
		color: var(--gg-danger);
		font-size: 11px;
	}

</style>
