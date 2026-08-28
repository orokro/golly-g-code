import { describe, it, expect } from 'vitest';
import { TYPES } from 'vue-settings-panel';
import { createSettings } from 'vue-settings-panel';
import { settingsSpec } from './spec.js';

const entries = Object.entries(settingsSpec.settings);

describe('the settings specification', () => {

	it('gives every setting a type the library knows', () => {
		const known = new Set(Object.values(TYPES));
		for (const [key, setting] of entries)
			expect(known.has(setting.type), key).toBe(true);
	});

	it('files every setting under a category that exists', () => {
		const slugs = new Set(settingsSpec.categories.map((c) => c.slug));
		for (const [key, setting] of entries)
			for (const cat of setting.cats)
				expect(slugs, `${key} -> ${cat}`).toContain(cat);
	});

	it('leaves no category empty', () => {
		const used = new Set(entries.flatMap(([, s]) => s.cats));
		for (const category of settingsSpec.categories)
			expect(used, category.slug).toContain(category.slug);
	});

	it('gives every setting a default, and an explanation', () => {
		for (const [key, setting] of entries) {
			expect(setting.default, key).not.toBeUndefined();
			expect(setting.desc, key).toBeTruthy();
		}
	});

	it('keeps every default inside its own range', () => {
		// a default outside its bounds shows as an immediately invalid field
		for (const [key, setting] of entries) {
			if (setting.opts?.min !== undefined)
				expect(setting.default, key).toBeGreaterThanOrEqual(setting.opts.min);
			if (setting.opts?.max !== undefined)
				expect(setting.default, key).toBeLessThanOrEqual(setting.opts.max);
		}
	});

	it('gives a select PLAIN options, which is what the panel renders', () => {
		// The previous version of this test read `options.map(o => o.value)`,
		// which is exactly the shape the spec wrongly used — so it passed while
		// the panel displayed `{ "label": "Millimetres", "value": "mm" }` in the
		// field. A test that encodes the same assumption as the code it checks
		// confirms they agree, not that either is right.
		for (const [key, setting] of entries) {
			if (setting.type !== TYPES.Select)
				continue;
			for (const option of setting.opts.options)
				expect(typeof option, `${key} option`).not.toBe('object');
		}
	});

	it('keeps every select default among its own options, by identity', () => {
		for (const [key, setting] of entries) {
			if (setting.type !== TYPES.Select)
				continue;
			expect(setting.opts.options, key).toContain(setting.default);
		}
	});

	it('initialises through the library, filling every key', () => {
		// checked against createSettings rather than against our own reading of
		// the spec, which would only prove we agree with ourselves
		const state = createSettings(settingsSpec);
		for (const [key, setting] of entries)
			expect(state[key], key).toEqual(setting.default);
	});

	it('holds only application settings, not document ones', () => {
		// stock thickness or work zero carried between projects is how a 4mm job
		// gets cut at 18mm depths
		const documentish = ['thickness', 'workZero', 'safeZ', 'feed', 'rpm', 'toolDiameter'];
		for (const key of Object.keys(settingsSpec.settings))
			for (const banned of documentish)
				expect(key.toLowerCase(), key).not.toContain(banned.toLowerCase());
	});
});
