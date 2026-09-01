import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';
import {
	Mode, CORNERS, MIN_SCALE, pointOn, centreOfBox, translation, rotation, scaling, applyDrag,
} from './gizmo.js';

/** A 100 x 60 box from the origin. */
const BOX = { minX: 0, minY: 0, maxX: 100, maxY: 60 };

/** A shape that has not been placed yet. */
const FRESH = { offset: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } };

/** Where a shape's centre ends up under a drag. */
const centreAfter = (start, centre, change) => {
	const next = applyDrag(start, centre, change);
	const offset = next.offset ?? start.offset;
	return [centre[0] + offset.x, centre[1] + offset.y];
};

const corner = (name) => CORNERS.find((c) => c.name === name);


describe('translating', () => {

	it('is the pointer’s own movement', () => {
		expect(translation([10, 10], [35, 2])).toEqual({ dx: 25, dy: -8 });
	});

	it('locks to whichever axis moved furthest, not to whichever moved first', () => {

		// Deciding on the first pixel makes shift-drag feel like a coin toss.
		expect(translation([0, 0], [30, 4], { axisLock: true })).toEqual({ dx: 30, dy: 0 });
		expect(translation([0, 0], [4, 30], { axisLock: true })).toEqual({ dx: 0, dy: 30 });
	});

	it('moves a shape by exactly that, leaving its rotation alone', () => {
		const next = applyDrag(FRESH, [50, 30], { mode: Mode.TRANSLATE, dx: 7, dy: -3 });
		expect(next.offset).toEqual({ x: 7, y: -3 });
		expect(next.rotation).toBeUndefined();
	});

	it('adds to an offset a shape already had', () => {
		const start = { ...FRESH, offset: { x: 10, y: 10 } };
		expect(applyDrag(start, [50, 30], { mode: Mode.TRANSLATE, dx: 5, dy: 5 }).offset)
			.toEqual({ x: 15, y: 15 });
	});
});


describe('rotating', () => {

	it('is the angle swept round the pivot', () => {
		expect(rotation([0, 0], [10, 0], [0, 10])).toBeCloseTo(Math.PI / 2, 9);
	});

	it('snaps when asked, and not otherwise', () => {
		const snap = Math.PI / 4;
		expect(rotation([0, 0], [10, 0], [10, 1], { snapRadians: snap })).toBe(0);
		expect(rotation([0, 0], [10, 0], [10, 1])).toBeGreaterThan(0);
	});

	it('turns a shape on the spot when the pivot is its own centre', () => {
		const next = applyDrag(FRESH, [50, 30], { mode: Mode.ROTATE, radians: Math.PI / 2 });
		expect(next.rotation).toBeCloseTo(Math.PI / 2, 9);
		expect(next.offset.x).toBeCloseTo(0, 9);
		expect(next.offset.y).toBeCloseTo(0, 9);
	});

	it('swings a shape ROUND a pivot that is not its centre, as well as turning it', () => {

		// The one that matters, and the one a naive implementation gets wrong:
		// setting only `rotation` makes four holes spin on the spot and stay in a
		// square, when what the user dragged was the square itself.
		const at = centreAfter(FRESH, [100, 0], {
			mode: Mode.ROTATE, radians: Math.PI / 2, pivot: [0, 0],
		});

		expect(at[0]).toBeCloseTo(0, 9);
		expect(at[1]).toBeCloseTo(100, 9);
	});

	it('turns a group as one piece — four holes stay a square, moved', () => {

		const holes = [[0, 0], [40, 0], [40, 40], [0, 40]];
		const pivot = [20, 20];

		const after = holes.map((centre) =>
			centreAfter(FRESH, centre, { mode: Mode.ROTATE, radians: Math.PI / 2, pivot }));

		// still a 40mm square, and each corner has moved to the next one round
		expect(after[0][0]).toBeCloseTo(40, 9);
		expect(after[0][1]).toBeCloseTo(0, 9);
		expect(after[1][0]).toBeCloseTo(40, 9);
		expect(after[1][1]).toBeCloseTo(40, 9);
	});

	it('adds to a rotation a shape already had', () => {
		const start = { ...FRESH, rotation: Math.PI / 2 };
		expect(applyDrag(start, [0, 0], { mode: Mode.ROTATE, radians: Math.PI / 2 }).rotation)
			.toBeCloseTo(Math.PI, 9);
	});
});


describe('scaling', () => {

	it('pivots on the OPPOSITE corner, so the one you are not holding stays put', () => {
		const { pivot } = scaling(BOX, corner('ne'), [200, 120]);
		expect(pivot).toEqual([0, 0]);
	});

	it('is the ratio the held corner moved by', () => {
		const { sx, sy } = scaling(BOX, corner('ne'), [200, 120]);
		expect(sx).toBeCloseTo(2, 9);
		expect(sy).toBeCloseTo(2, 9);
	});

	it('moves one axis for an edge handle and leaves the other alone', () => {
		const { sx, sy } = scaling(BOX, corner('e'), [50, 999]);
		expect(sx).toBeCloseTo(0.5, 9);
		expect(sy).toBe(1);
	});

	it('keeps the aspect ratio when asked, taking the axis that actually moved', () => {
		const { sx, sy } = scaling(BOX, corner('ne'), [200, 61], { uniform: true });
		expect(sx).toBeCloseTo(2, 9);
		expect(sy).toBeCloseTo(2, 9);
	});

	it('pivots on the centre when asked, so the box grows both ways', () => {
		const { pivot } = scaling(BOX, corner('ne'), [200, 120], { fromCentre: true });
		expect(pivot).toEqual([50, 30]);
	});

	it('allows a mirror but never a collapse to nothing', () => {
		expect(scaling(BOX, corner('ne'), [-100, -60]).sx).toBeLessThan(0);
		expect(Math.abs(scaling(BOX, corner('ne'), [0, 0]).sx)).toBeGreaterThanOrEqual(MIN_SCALE);
	});

	it('does not scale a box with no width, rather than returning Infinity', () => {
		const flat = { minX: 5, minY: 0, maxX: 5, maxY: 60 };
		expect(scaling(flat, corner('ne'), [50, 120]).sx).toBe(1);
	});

	it('multiplies the shape’s scale and moves it away from the pivot', () => {
		const at = centreAfter(FRESH, [50, 30], {
			mode: Mode.SCALE, sx: 2, sy: 2, pivot: [0, 0],
		});
		expect(at).toEqual([100, 60]);
		expect(applyDrag(FRESH, [50, 30], { mode: Mode.SCALE, sx: 2, sy: 2, pivot: [0, 0] }).scale)
			.toEqual({ x: 2, y: 2 });
	});

	it('compounds with a scale the shape already had', () => {
		const start = { ...FRESH, scale: { x: 3, y: 3 } };
		expect(applyDrag(start, [0, 0], { mode: Mode.SCALE, sx: 2, sy: 2 }).scale)
			.toEqual({ x: 6, y: 6 });
	});

	it('scales a ROTATED shape in its own frame — the model’s one limitation', () => {

		// Pinned rather than discovered. Three fields cannot express shear, so a
		// non-uniform drag on a turned shape stretches it along its own axis
		// rather than along the world's. Uniform scaling, which is what the corner
		// handles do without a modifier, is identical either way.
		const start = { ...FRESH, rotation: Math.PI / 2 };
		expect(applyDrag(start, [0, 0], { mode: Mode.SCALE, sx: 2, sy: 1 }).scale)
			.toEqual({ x: 2, y: 1 });
	});
});


describe('the box helpers', () => {

	it('finds a point at fractions of the box', () => {
		expect(pointOn(BOX, 0, 0)).toEqual([0, 0]);
		expect(pointOn(BOX, 1, 1)).toEqual([100, 60]);
		expect(centreOfBox(BOX)).toEqual([50, 30]);
	});

	it('has eight handles, all on the edge and none in the middle', () => {
		expect(CORNERS).toHaveLength(8);
		expect(CORNERS.some((c) => c.fx === 0.5 && c.fy === 0.5)).toBe(false);
	});
});


describe('the gizmo’s paint order, which decides what you actually grab', () => {

	// Not a unit test of a function, and deliberately so. The defect was pure
	// paint order: the move target was declared LAST in the template, so it
	// painted over all eight scale grips. Every grip straddles the box edge, so
	// half of each one was a move handle wearing a resize cursor — and measured in
	// a browser, every single grip moved the object instead of scaling it.
	//
	// Nothing reachable from a function call can see that, so this reads the
	// template itself. Crude, but it pins the one thing that has to stay true.

	const source = readFileSync(
		new URL('../WorkspaceWindow.vue', import.meta.url), 'utf8');

	it('puts the move target UNDER everything else in the gizmo', () => {

		const mover = source.indexOf('class="mover"');
		const frame = source.indexOf('class="frame"');
		const knob = source.indexOf('class="knob"');
		const grip = source.indexOf('class="grip"');

		expect(mover, 'the gizmo has a move target').toBeGreaterThan(-1);
		expect(grip, 'the gizmo has scale grips').toBeGreaterThan(-1);

		expect(mover).toBeLessThan(grip);
		expect(mover).toBeLessThan(knob);
		expect(mover).toBeLessThan(frame);
	});

	it('keeps the gizmo above the transparent hit strokes', () => {

		// The other half of the same lesson, from the tab handles: a handle that is
		// not the topmost thing under the cursor is not a handle. It sat under an
		// 8px invisible stroke and selected the shape behind it instead.
		expect(source.indexOf('class="hit"')).toBeLessThan(source.indexOf('class="gizmo"'));
	});
});
