import { describe, it, expect } from 'vitest';
import { defaultLayout } from './defaultLayout.js';
import { windowSlugs } from '../windows/registry.js';

describe('the default layout', () => {

	it('only names windows this build actually has', () => {
		// the layout store rejects a layout naming an unknown window, so a typo
		// here would silently fall back to... this layout, forever
		for (const frame of defaultLayout())
			for (const entry of frame.windows ?? [])
				expect(windowSlugs, `${frame.name}`).toContain(entry);
	});

	it('places every window somewhere', () => {
		const placed = new Set(defaultLayout().flatMap((f) => f.windows ?? []));
		for (const slug of windowSlugs)
			expect(placed, slug).toContain(slug);
	});

	it('has a root frame for the others to reference', () => {
		expect(defaultLayout()[0]).toMatchObject({ name: 'window', top: 0, left: 0 });
	});

	it('only references frames that exist, and only ones defined before them', () => {
		// a reference resolves against frames already laid out; a forward
		// reference is a layout that half-appears with no error
		const seen = new Set();
		for (const frame of defaultLayout()) {
			for (const edge of ['top', 'left', 'bottom', 'right']) {
				const value = frame[edge];
				if (!Array.isArray(value) || value[0] !== 'ref')
					continue;
				const target = value[1].split('.')[0];
				expect(seen, `${frame.name}.${edge} -> ${target}`).toContain(target);
			}
			seen.add(frame.name);
		}
	});

	it('returns a fresh object every time', () => {
		// the manager mutates what it is handed; a shared constant given to two
		// managers, or to one twice after a reset, is a slow bug to find
		const a = defaultLayout();
		const b = defaultLayout();
		expect(a).not.toBe(b);
		expect(a[1]).not.toBe(b[1]);
		a[1].windows.push('workspace');
		expect(b[1].windows).not.toContain('workspace');
	});

	it('gives no frame a zero or negative extent', () => {
		for (const frame of defaultLayout()) {
			if (typeof frame.left === 'number' && typeof frame.right === 'number')
				expect(frame.right, frame.name).toBeGreaterThan(frame.left);
			if (typeof frame.top === 'number' && typeof frame.bottom === 'number')
				expect(frame.bottom, frame.name).toBeGreaterThan(frame.top);
		}
	});
});
