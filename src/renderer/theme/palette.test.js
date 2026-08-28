import { describe, it, expect } from 'vitest';
import { presets, dark, light, windowManagerTheme, cssVariables, applyPalette } from './palette.js';

const ROLES = Object.keys(dark).filter((k) => k !== 'name' && k !== 'dark');


describe('presets', () => {

	it('define every role, in every preset', () => {
		// a missing role is a component silently falling back to a browser
		// default, which looks like a styling bug somewhere else entirely
		for (const [name, palette] of Object.entries(presets))
			for (const role of ROLES)
				expect(palette[role], `${name}.${role}`).toMatch(/^#[0-9a-f]{6}$/i);
	});

	it('say which of them are dark', () => {
		expect(dark.dark).toBe(true);
		expect(light.dark).toBe(false);
	});

	it('put text and background far enough apart to read', () => {
		// crude luminance, but enough to catch a preset where a role was pasted
		// into the wrong slot — the failure mode that produces grey-on-grey
		const luminance = (hex) => {
			const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
			return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
		};
		for (const [name, palette] of Object.entries(presets)) {
			expect(Math.abs(luminance(palette.text) - luminance(palette.surface)), `${name} body`)
				.toBeGreaterThan(0.4);
			expect(Math.abs(luminance(palette.accentText) - luminance(palette.accent)), `${name} accent`)
				.toBeGreaterThan(0.25);
		}
	});
});


describe('deriving the window manager theme', () => {

	it('maps every key it sets to a colour from the palette', () => {
		const theme = windowManagerTheme(dark);
		const known = new Set(ROLES.map((role) => dark[role]));
		for (const [key, value] of Object.entries(theme))
			expect(known.has(value), `${key} = ${value}`).toBe(true);
	});

	it('changes with the preset rather than being hard-coded', () => {
		expect(windowManagerTheme(dark)).not.toEqual(windowManagerTheme(light));
		expect(windowManagerTheme(light).systemBGColor).toBe(light.background);
	});
});


describe('CSS variables', () => {

	it('cover both conventions from one palette', () => {
		const vars = cssVariables(dark);
		// ours, plus the settings panel's two groups
		expect(Object.keys(vars).some((k) => k.startsWith('--gg-'))).toBe(true);
		expect(Object.keys(vars).some((k) => k.startsWith('--lc-'))).toBe(true);
		expect(Object.keys(vars).some((k) => k.startsWith('--mc-'))).toBe(true);
	});

	it('never leaves a variable undefined', () => {
		for (const palette of Object.values(presets))
			for (const [name, value] of Object.entries(cssVariables(palette)))
				expect(value, `${palette.name} ${name}`).toBeTruthy();
	});

	it('keeps the two conventions agreeing about the same surface', () => {
		// the drift this module exists to prevent: the settings panel's content
		// background must BE the window surface, not a colour that resembles it
		const vars = cssVariables(light);
		expect(vars['--mc-bg-color']).toBe(vars['--gg-surface']);
		expect(vars['--lc-bg-color']).toBe(vars['--gg-surface-raised']);
	});
});


describe('applying a palette', () => {

	/** The smallest thing that behaves like an element for this purpose. */
	const fakeElement = () => ({
		dataset: {},
		style: {
			values: {},
			setProperty(name, value) { this.values[name] = value; },
		},
	});

	it('writes every variable and records which preset is on', () => {
		const element = fakeElement();
		applyPalette(light, element);

		expect(element.dataset.theme).toBe('light');
		expect(element.style.values['--gg-surface']).toBe(light.surface);
		expect(Object.keys(element.style.values)).toHaveLength(
			Object.keys(cssVariables(light)).length);
	});

	it('replaces the previous preset completely when switching', () => {
		const element = fakeElement();
		applyPalette(dark, element);
		applyPalette(light, element);

		for (const [name, value] of Object.entries(cssVariables(light)))
			expect(element.style.values[name], name).toBe(value);
	});

	it('does nothing rather than throwing when there is no document', () => {
		expect(() => applyPalette(dark, null)).not.toThrow();
	});
});
