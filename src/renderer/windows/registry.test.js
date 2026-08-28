import { describe, it, expect } from 'vitest';
import { availableWindows, windowSlugs } from './registry.js';

describe('the window registry', () => {

	it('gives every window an explicit slug', () => {
		// an auto-derived slug comes from the build-time component name, which
		// minification renames — so a layout saved before a release stops
		// matching the windows in the release, silently
		for (const entry of availableWindows) {
			expect(typeof entry.slug, entry.title).toBe('string');
			expect(entry.slug.length).toBeGreaterThan(0);
		}
	});

	it('never repeats a slug', () => {
		expect(new Set(windowSlugs).size).toBe(windowSlugs.length);
	});

	it('gives every window a title and a component', () => {
		for (const entry of availableWindows) {
			expect(entry.title, entry.slug).toBeTruthy();
			expect(entry.window, entry.slug).toBeTruthy();
		}
	});

	it('uses slugs that survive being written into a saved layout', () => {
		// lower case, no spaces or punctuation: a slug ends up inside JSON and
		// inside a `;<job>` style comment, and should never need escaping
		for (const slug of windowSlugs)
			expect(slug, slug).toMatch(/^[a-z][a-z0-9]*$/);
	});

	it('covers every window the plan calls for', () => {
		for (const slug of ['outliner', 'inspector', 'workspace', 'preview3d',
			'preview2d', 'code', 'timeline', 'settings'])
			expect(windowSlugs, slug).toContain(slug);
	});
});
