import { describe, it, expect } from 'vitest';
import {
	generateToolpath, orientForCut, bandOffsets, Operation, Direction,
} from './operations.js';
import { signedArea, isClockwise } from '../geometry/clipper.js';

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const reversed = (p) => [...p].reverse();

const boundsOf = (paths) => {
	const pts = paths.flatMap((p) => p.points);
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};

const base = { toolDiameter: 3, cutDepth: 6, passDepth: 2 };


describe('offsets by side', () => {

	it('puts the tool outside the shape for an outside cut', () => {
		const result = generateToolpath([rect(0, 0, 40, 40)], { ...base, operation: Operation.OUTSIDE });
		const b = boundsOf(result.paths);
		expect(b.minX).toBeCloseTo(-1.5, 1);
		expect(b.maxX).toBeCloseTo(41.5, 1);
	});

	it('puts the tool inside the shape for an inside cut', () => {
		const result = generateToolpath([rect(0, 0, 40, 40)], { ...base, operation: Operation.INSIDE });
		const b = boundsOf(result.paths);
		expect(b.minX).toBeCloseTo(1.5, 6);
		expect(b.maxX).toBeCloseTo(38.5, 6);
	});

	it('leaves the tool on the line for centre and engrave', () => {
		for (const operation of [Operation.CENTER, Operation.ENGRAVE]) {
			const b = boundsOf(generateToolpath([rect(0, 0, 40, 40)], { ...base, operation }).paths);
			expect(b.minX, operation).toBeCloseTo(0, 6);
			expect(b.maxX, operation).toBeCloseTo(40, 6);
		}
	});

	it('leaves extra material when a positive margin is given', () => {
		const plain = boundsOf(generateToolpath([rect(0, 0, 40, 40)], { ...base, operation: Operation.OUTSIDE }).paths);
		const withMargin = boundsOf(generateToolpath([rect(0, 0, 40, 40)], { ...base, operation: Operation.OUTSIDE, margin: 2 }).paths);
		expect(withMargin.minX).toBeCloseTo(plain.minX - 2, 1);
	});

	it('ignores margin for engrave, which traces the artwork exactly', () => {
		const b = boundsOf(generateToolpath([rect(0, 0, 40, 40)], { ...base, operation: Operation.ENGRAVE, margin: 5 }).paths);
		expect(b.minX).toBeCloseTo(0, 6);
	});

	it('reports it plainly when the tool does not fit', () => {
		const result = generateToolpath([rect(0, 0, 2, 2)], { ...base, operation: Operation.INSIDE });
		expect(result.paths).toHaveLength(0);
		expect(result.warnings.join(' ')).toMatch(/does not fit/i);
	});
});


describe('cut direction', () => {

	it('runs an outside climb cut clockwise', () => {
		const result = generateToolpath([rect(0, 0, 40, 40)], {
			...base, operation: Operation.OUTSIDE, direction: Direction.CLIMB,
		});
		expect(isClockwise(result.paths[0].points)).toBe(true);
	});

	it('runs an outside conventional cut counter-clockwise', () => {
		const result = generateToolpath([rect(0, 0, 40, 40)], {
			...base, operation: Operation.OUTSIDE, direction: Direction.CONVENTIONAL,
		});
		expect(isClockwise(result.paths[0].points)).toBe(false);
	});

	it('FLIPS the travel direction for an inside cut', () => {
		// climb describes how the edge meets the material, not which way round a
		// loop you go -- so the same milling style is the opposite travel direction
		// on the inside of a boundary
		const outside = generateToolpath([rect(0, 0, 40, 40)], {
			...base, operation: Operation.OUTSIDE, direction: Direction.CLIMB,
		});
		const inside = generateToolpath([rect(0, 0, 40, 40)], {
			...base, operation: Operation.INSIDE, direction: Direction.CLIMB,
		});
		expect(isClockwise(outside.paths[0].points)).toBe(true);
		expect(isClockwise(inside.paths[0].points)).toBe(false);
	});

	it('keeps a hole wound opposite its outer, so each cuts its own side correctly', () => {
		// a hole inside a profile cut IS an inside cut, even though the operation
		// is "outside"
		const result = generateToolpath(
			[rect(0, 0, 60, 60), reversed(rect(20, 20, 20, 20))],
			{ ...base, operation: Operation.OUTSIDE, direction: Direction.CLIMB },
		);

		expect(result.paths).toHaveLength(2);

		const areas = result.paths.map((p) => signedArea(p.points));
		const outer = areas.find((a) => Math.abs(a) > 1000);
		const hole = areas.find((a) => Math.abs(a) < 1000);

		expect(Math.sign(outer)).not.toBe(Math.sign(hole));
	});

	it('leaves direction alone when there is nothing to orient', () => {
		expect(orientForCut([], Direction.CLIMB, false)).toEqual([]);
	});
});


describe('bands', () => {

	it('makes a single pass when no width is asked for', () => {
		expect(bandOffsets(1.5, 0, 0, 0.4)).toEqual([1.5]);
	});

	it('makes a single pass when the band is narrower than the tool', () => {
		expect(bandOffsets(1.5, 0, 2, 0.4)).toEqual([1.5]);
	});

	it('steps across a wider band and lands exactly on its far edge', () => {
		const offsets = bandOffsets(1.5, 0, 10, 0.4);
		expect(offsets[0]).toBeCloseTo(1.5, 9);
		expect(offsets[offsets.length - 1]).toBeCloseTo(8.5, 9);
		for (let i = 1; i < offsets.length; i++)
			expect(offsets[i] - offsets[i - 1]).toBeLessThanOrEqual(1.2 + 1e-9);
	});

	it('widens the cut when a band is requested', () => {
		const narrow = generateToolpath([rect(0, 0, 40, 40)], { ...base, operation: Operation.OUTSIDE });
		const wide = generateToolpath([rect(0, 0, 40, 40)], { ...base, operation: Operation.OUTSIDE, width: 10 });
		expect(wide.paths.length).toBeGreaterThan(narrow.paths.length);
		expect(boundsOf(wide.paths).maxX).toBeGreaterThan(boundsOf(narrow.paths).maxX);
	});
});


describe('pocket', () => {

	it('clears the inside with concentric rings', () => {
		const result = generateToolpath([rect(0, 0, 40, 40)], {
			...base, operation: Operation.POCKET, stepover: 0.4,
		});
		expect(result.paths.length).toBeGreaterThan(3);
	});

	it('orders rings innermost first, so the plunge lands in open space', () => {
		const result = generateToolpath([rect(0, 0, 40, 40)], {
			...base, operation: Operation.POCKET, stepover: 0.4,
		});

		const area = (p) => Math.abs(signedArea(p.points));
		expect(area(result.paths[0])).toBeLessThan(area(result.paths[result.paths.length - 1]));
	});

	it('keeps every ring inside the shape', () => {
		const b = boundsOf(generateToolpath([rect(0, 0, 40, 40)], {
			...base, operation: Operation.POCKET,
		}).paths);
		expect(b.minX).toBeGreaterThanOrEqual(1.5 - 1e-6);
		expect(b.maxX).toBeLessThanOrEqual(38.5 + 1e-6);
	});

	it('uses more rings at a finer stepover', () => {
		const coarse = generateToolpath([rect(0, 0, 40, 40)], { ...base, operation: Operation.POCKET, stepover: 0.8 });
		const fine = generateToolpath([rect(0, 0, 40, 40)], { ...base, operation: Operation.POCKET, stepover: 0.2 });
		expect(fine.paths.length).toBeGreaterThan(coarse.paths.length);
	});
});


describe('cleanup before offsetting', () => {

	it('removes a zero-width bridge and says so, so an engrave cannot follow it', () => {
		// the real shape from jscut's test.svg: an outer rectangle joined to its
		// hole by a segment traced out and back
		const bridged = [[
			[4.7, 107.8], [51.6, 107.8], [51.6, 70.3], [32.8, 70.3], [32.8, 79.6],
			[42.2, 79.6], [42.2, 98.4], [14.1, 98.4], [14.1, 79.6], [32.8, 79.6],
			[32.8, 70.3], [4.7, 70.3],
		]];

		const result = generateToolpath(bridged, { ...base, operation: Operation.ENGRAVE });

		expect(result.paths).toHaveLength(2);
		expect(result.warnings.join(' ')).toMatch(/bridge/i);

		// Assert the RELATIONSHIP rather than absolute areas: the corner
		// coordinates above are rounded to 0.1mm, so their exact area is not
		// meaningful, but outer minus hole must still equal the area the bridged
		// contour enclosed all along.
		const areas = result.paths.map((p) => Math.abs(signedArea(p.points)));
		const outer = Math.max(...areas);
		const hole = Math.min(...areas);

		expect(outer - hole).toBeCloseTo(Math.abs(signedArea(bridged[0])), 6);

		// and the two loops are the outer boundary and its hole, not slivers
		expect(outer).toBeGreaterThan(1500);
		expect(hole).toBeGreaterThan(400);
	});

	it('resolves a self-intersecting contour before cutting it', () => {
		const bowtie = [[[0, 0], [20, 20], [20, 0], [0, 20]]];
		const result = generateToolpath(bowtie, { ...base, operation: Operation.OUTSIDE });
		expect(result.paths.length).toBeGreaterThan(0);
		expect(result.paths.every((p) => Number.isFinite(signedArea(p.points)))).toBe(true);
	});
});


describe('depths and validation', () => {

	it('carries the depth passes alongside the geometry', () => {
		const result = generateToolpath([rect(0, 0, 40, 40)], {
			...base, operation: Operation.OUTSIDE, cutDepth: 5, passDepth: 2,
		});
		expect(result.depths).toEqual([-2, -4, -5]);
	});

	it('rejects an unknown operation', () => {
		expect(() => generateToolpath([rect(0, 0, 10, 10)], { ...base, operation: 'vcarve' }))
			.toThrow(TypeError);
	});

	it('rejects a nonsensical tool or stepover', () => {
		expect(() => generateToolpath([rect(0, 0, 10, 10)], { ...base, operation: Operation.OUTSIDE, toolDiameter: 0 }))
			.toThrow(RangeError);
		expect(() => generateToolpath([rect(0, 0, 10, 10)], { ...base, operation: Operation.POCKET, stepover: 0 }))
			.toThrow(RangeError);
		expect(() => generateToolpath([rect(0, 0, 10, 10)], { ...base, operation: Operation.POCKET, stepover: 1.5 }))
			.toThrow(RangeError);
	});

	it('handles empty geometry without throwing', () => {
		const result = generateToolpath([], { ...base, operation: Operation.OUTSIDE });
		expect(result.paths).toEqual([]);
		expect(result.depths.length).toBeGreaterThan(0);
	});
});
