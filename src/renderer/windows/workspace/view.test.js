import { describe, it, expect } from 'vitest';

import {
	MIN_SCALE, MAX_SCALE, createView, viewTransform, toScreen, toWorld,
	panBy, zoomAt, fitBounds, gridSpacing,
} from './view.js';


describe('the Y flip', () => {

	it('puts +Y up on screen, which is down in pixels', () => {
		// the core is Y-up to match the machine; SVG is Y-down. This is the one
		// place that reconciles them, and jscut deferring the same flip all the
		// way to its G-code emitter is why every stage in between disagreed
		const view = { scale: 2, x: 100, y: 100 };

		expect(toScreen(view, 0, 0)).toEqual({ x: 100, y: 100 });
		expect(toScreen(view, 0, 10)).toEqual({ x: 100, y: 80 });
		expect(toScreen(view, 10, 0)).toEqual({ x: 120, y: 100 });
	});

	it('is in the transform too, so the DOM and the arithmetic agree', () => {
		expect(viewTransform({ scale: 2, x: 100, y: 50 }))
			.toBe('translate(100 50) scale(2 -2)');
	});

	it('comes back to where it started', () => {
		const view = { scale: 3.5, x: -40, y: 220 };

		for (const [x, y] of [[0, 0], [12.5, -7], [-100, 400]]) {
			const screen = toScreen(view, x, y);
			const back = toWorld(view, screen.x, screen.y);
			expect(back.x).toBeCloseTo(x, 9);
			expect(back.y).toBeCloseTo(y, 9);
		}
	});
});


describe('panning', () => {

	it('moves the world with the pointer', () => {
		expect(panBy({ scale: 2, x: 10, y: 20 }, 5, -5)).toEqual({ scale: 2, x: 15, y: 15 });
	});

	it('does not change the scale', () => {
		expect(panBy(createView(), 100, 100).scale).toBe(1);
	});
});


describe('zooming', () => {

	it('keeps the point under the cursor under the cursor', () => {
		// the only zoom behaviour that does not feel like a fight
		const view = { scale: 2, x: 100, y: 300 };
		const before = toWorld(view, 250, 180);
		const after = zoomAt(view, 1.8, 250, 180);
		const back = toWorld(after, 250, 180);

		expect(back.x).toBeCloseTo(before.x, 9);
		expect(back.y).toBeCloseTo(before.y, 9);
		expect(after.scale).toBeCloseTo(3.6, 9);
	});

	it('holds the cursor point through a long run of steps', () => {
		// one step being right is not the same as fifty being right, and drift
		// here shows up as the drawing crawling away while you scroll
		let view = { scale: 1, x: 400, y: 300 };
		const target = toWorld(view, 512, 288);

		for (let i = 0; i < 50; i += 1)
			view = zoomAt(view, i % 2 === 0 ? 1.2 : 1 / 1.15, 512, 288);

		const back = toWorld(view, 512, 288);
		expect(back.x).toBeCloseTo(target.x, 6);
		expect(back.y).toBeCloseTo(target.y, 6);
	});

	it('stops at the limits rather than inverting or vanishing', () => {
		let view = createView();

		for (let i = 0; i < 200; i += 1)
			view = zoomAt(view, 2, 0, 0);

		expect(view.scale).toBe(MAX_SCALE);

		for (let i = 0; i < 400; i += 1)
			view = zoomAt(view, 0.5, 0, 0);

		expect(view.scale).toBe(MIN_SCALE);
	});
});


describe('fitting a box into a viewport', () => {

	const size = { width: 800, height: 600 };

	it('centres it', () => {
		const view = fitBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, size);
		const middle = toScreen(view, 50, 50);

		expect(middle.x).toBeCloseTo(400, 6);
		expect(middle.y).toBeCloseTo(300, 6);
	});

	it('fits the tighter of the two axes, so nothing is cut off', () => {
		const view = fitBounds({ minX: 0, minY: 0, maxX: 400, maxY: 100 }, size);
		const corners = [toScreen(view, 0, 0), toScreen(view, 400, 100)];

		for (const corner of corners) {
			expect(corner.x).toBeGreaterThanOrEqual(0);
			expect(corner.x).toBeLessThanOrEqual(size.width);
			expect(corner.y).toBeGreaterThanOrEqual(0);
			expect(corner.y).toBeLessThanOrEqual(size.height);
		}
	});

	it('leaves a margin rather than touching the edges', () => {
		const view = fitBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, size);
		const left = toScreen(view, 0, 0).x;

		expect(left).toBeGreaterThan(0);
	});

	it('handles a box with no width, which a single straight line has', () => {
		const view = fitBounds({ minX: 5, minY: 0, maxX: 5, maxY: 100 }, size);

		expect(Number.isFinite(view.scale)).toBe(true);
		expect(view.scale).toBeGreaterThan(0);
		expect(toScreen(view, 5, 50).x).toBeCloseTo(400, 6);
	});

	it('gives up gracefully on nothing to fit, or nowhere to fit it', () => {
		expect(fitBounds(null, size)).toEqual(createView());
		expect(fitBounds({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { width: 0, height: 0 }))
			.toEqual(createView());
	});
});


describe('the grid spacing', () => {

	it('walks 1-2-5 so a cell is always a readable size', () => {
		for (const scale of [0.05, 0.3, 1, 4, 17, 120, 400]) {
			const spacing = gridSpacing(scale);
			const digits = spacing / (10 ** Math.floor(Math.log10(spacing)));

			expect([1, 2, 5].some((d) => Math.abs(digits - d) < 1e-9), `${scale} -> ${spacing}`).toBe(true);
			expect(spacing * scale, `${scale} -> ${spacing}`).toBeGreaterThanOrEqual(8);
		}
	});

	it('never leaves a cell far bigger than it needs to be', () => {
		// a fixed 10mm grid is a wall of lines zoomed out and one line zoomed in;
		// the point of walking the sequence is that neither ever happens
		for (const scale of [0.05, 0.3, 1, 4, 17, 120, 400])
			expect(gridSpacing(scale) * scale, `${scale}`).toBeLessThan(80);
	});

	it('is coarser when zoomed out and finer when zoomed in', () => {
		expect(gridSpacing(0.2)).toBeGreaterThan(gridSpacing(20));
	});

	it('says something sensible for a nonsense scale', () => {
		expect(gridSpacing(0)).toBe(10);
		expect(gridSpacing(-1)).toBe(10);
	});
});
