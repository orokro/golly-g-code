import { describe, it, expect } from 'vitest';

import { normalizePathData } from '@core/path/normalize.js';

import { pathData, boundsOf, unionBounds, padBounds, DISPLAY_TOLERANCE } from './geometry.js';

/** Normalizes path data the way the importer does. */
const parse = (d) => normalizePathData(d).subPaths;


describe('building path data', () => {

	it('emits a move, the segments, and a close', () => {
		expect(pathData(parse('M0 0 L10 0 L10 10 Z'))).toBe('M0 0L10 0L10 10L0 0Z');
	});

	it('keeps cubics as cubics, so the browser draws them exactly at any zoom', () => {
		// flattening here would fix the curve's resolution at whatever zoom
		// happened to be current when it was built
		const d = pathData(parse('M0 0 C0 5 5 10 10 10'));

		expect(d).toBe('M0 0C0 5 5 10 10 10');
		expect(d).not.toMatch(/L/);
	});

	it('flattens arcs, because they are stored centre-parameterised for G2/G3', () => {
		const d = pathData(parse('M0 0 A10 10 0 0 1 20 0'));

		expect(d.startsWith('M0 0L')).toBe(true);
		expect(d.split('L').length).toBeGreaterThan(20);
	});

	it('flattens an arc finely enough that no zoom can show the difference', () => {
		// every flattened point must sit within the tolerance of the true radius
		const [sub] = parse('M0 0 A10 10 0 0 1 20 0');
		const [cx, cy] = sub.segments[0].arc.centre;
		const points = pathData(parse('M0 0 A10 10 0 0 1 20 0'))
			.slice(1).split('L').filter(Boolean)
			.map((pair) => pair.trim().split(' ').map(Number));

		for (const [x, y] of points.slice(0, -1)) {
			const r = Math.hypot(x - cx, y - cy);
			expect(Math.abs(r - 10)).toBeLessThanOrEqual(DISPLAY_TOLERANCE * 1.5);
		}
	});

	it('handles several subpaths, which is a shape with a hole', () => {
		const d = pathData(parse('M0 0 h10 v10 h-10 Z M2 2 h6 v6 h-6 Z'));

		expect(d.match(/M/g)).toHaveLength(2);
		expect(d.match(/Z/g)).toHaveLength(2);
	});

	it('leaves an open subpath open', () => {
		expect(pathData(parse('M0 0 L10 10'))).toBe('M0 0L10 10');
	});

	it('trims coordinates without letting them drift', () => {
		const d = pathData(parse('M0.123456789 0 L10 0'));

		expect(d).toBe('M0.1235 0L10 0');
	});

	it('says nothing rather than something broken, for nothing', () => {
		expect(pathData([])).toBe('');
		expect(pathData(undefined)).toBe('');
		expect(pathData([{ start: [0, 0], segments: [] }])).toBe('');
	});
});


describe('bounds', () => {

	it('covers a simple shape exactly', () => {
		expect(boundsOf(parse('M0 0 h30 v20 h-30 Z')))
			.toEqual({ minX: 0, minY: 0, maxX: 30, maxY: 20 });
	});

	it('bounds a cubic by its control points — a true bound, not a tight one', () => {
		// the curve lies inside the hull of its control points, so this is safe.
		// A tight bound means solving for extrema, which is real work to be
		// slightly wrong about in the other direction
		const box = boundsOf(parse('M0 0 C0 100 10 100 10 0'));

		expect(box).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 100 });
	});

	it('bounds an arc by its circle', () => {
		// and gives a box at all: reading the centre as `arc.cx` rather than
		// `arc.centre[0]` produced NaN, which `Number.isFinite` turned into a
		// null box and a workspace that silently would not zoom to anything
		const box = boundsOf(parse('M0 0 A10 10 0 0 1 20 0'));

		expect(box).not.toBeNull();
		expect(box.minX).toBeLessThanOrEqual(0);
		expect(box.maxX).toBeGreaterThanOrEqual(20);
		expect(box.maxY).toBeGreaterThanOrEqual(10);
	});

	it('gives a finite box for every kind of segment there is', () => {
		// the shape of a stored arc is not ours, so a field renamed upstream
		// should fail here rather than surface as a view that will not fit
		for (const d of ['M0 0 L10 10', 'M0 0 C0 5 5 10 10 10', 'M0 0 A10 10 0 0 1 20 0']) {
			const box = boundsOf(parse(d));
			expect(box, d).not.toBeNull();
			for (const value of Object.values(box))
				expect(Number.isFinite(value), `${d} ${value}`).toBe(true);
		}
	});

	it('is null for nothing', () => {
		expect(boundsOf([])).toBeNull();
		expect(boundsOf(undefined)).toBeNull();
	});

	it('unions several, ignoring the empty ones', () => {
		expect(unionBounds([
			{ minX: 0, minY: 0, maxX: 10, maxY: 10 },
			null,
			{ minX: -5, minY: 4, maxX: 3, maxY: 30 },
		])).toEqual({ minX: -5, minY: 0, maxX: 10, maxY: 30 });

		expect(unionBounds([null, undefined])).toBeNull();
	});

	it('pads a box on every side', () => {
		expect(padBounds({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 2))
			.toEqual({ minX: -2, minY: -2, maxX: 12, maxY: 12 });

		expect(padBounds(null, 2)).toBeNull();
	});
});
