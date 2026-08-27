import { describe, it, expect } from 'vitest';
import {
	offsetByHeading, offsetAlongNormals, resample, Side, DEFAULT_CLEAN,
} from './openOffset.js';

/** Shortest distance from a point to a polyline. */
const distanceToPath = (point, path) => {
	let best = Infinity;
	for (let i = 0; i + 1 < path.length; i++) {
		const [ax, ay] = path[i];
		const [bx, by] = path[i + 1];
		const vx = bx - ax, vy = by - ay;
		const lengthSquared = (vx * vx) + (vy * vy);
		let t = lengthSquared === 0 ? 0 : (((point[0] - ax) * vx) + ((point[1] - ay) * vy)) / lengthSquared;
		t = Math.max(0, Math.min(1, t));
		best = Math.min(best, Math.hypot(point[0] - (ax + (t * vx)), point[1] - (ay + (t * vy))));
	}
	return best;
};

/** A sine wave sampled finely, with a given amplitude and wavelength. */
const wave = (amplitude, wavelength, width = 200, step = 0.25) => {
	const pts = [];
	for (let x = 0; x <= width; x += step)
		pts.push([x, amplitude * Math.sin((2 * Math.PI * x) / wavelength)]);
	return pts;
};

/** Radius of curvature at the peak of such a wave. */
const peakRadius = (amplitude, wavelength) => (wavelength * wavelength) / (4 * Math.PI * Math.PI * amplitude);


describe('heading offset', () => {

	it('moves every point by the same vector', () => {
		const source = [[0, 0], [10, 0], [10, 10]];
		const moved = offsetByHeading(source, 5, Math.PI / 2);

		expect(moved[0][0]).toBeCloseTo(0, 9);
		expect(moved[0][1]).toBeCloseTo(5, 9);
		expect(moved[2][1]).toBeCloseTo(15, 9);
	});

	it('preserves the shape exactly, so it can never fold', () => {
		const source = wave(20, 10, 100);
		const moved = offsetByHeading(source, 7, 0.7);

		for (let i = 1; i < source.length; i++) {
			const before = Math.hypot(source[i][0] - source[i - 1][0], source[i][1] - source[i - 1][1]);
			const after = Math.hypot(moved[i][0] - moved[i - 1][0], moved[i][1] - moved[i - 1][1]);
			expect(after).toBeCloseTo(before, 9);
		}
	});
});


describe('normal offset — the well-behaved regime', () => {

	it('offsets a straight line to a parallel line at exactly the distance', () => {
		const { points } = offsetAlongNormals([[0, 0], [100, 0]], 3, { side: Side.LEFT });
		for (const [, y] of points)
			expect(y).toBeCloseTo(3, 9);
	});

	it('puts left and right on opposite sides', () => {
		const left = offsetAlongNormals([[0, 0], [100, 0]], 3, { side: Side.LEFT });
		const right = offsetAlongNormals([[0, 0], [100, 0]], 3, { side: Side.RIGHT });
		expect(left.points[0][1]).toBeCloseTo(3, 9);
		expect(right.points[0][1]).toBeCloseTo(-3, 9);
	});

	it('holds the full offset distance everywhere when the bend is gentle', () => {
		// radius of curvature comfortably larger than the offset, so nothing folds
		const source = wave(6, 90);
		expect(peakRadius(6, 90)).toBeGreaterThan(4);

		const { points, removed } = offsetAlongNormals(source, 1.5, { side: Side.LEFT });

		expect(removed).toBe(0);
		for (const point of points)
			expect(distanceToPath(point, source)).toBeCloseTo(1.5, 2);
	});

	it('rounds an outward corner instead of chording across it', () => {
		// a square corner offset on its outside must sweep an arc, or the offset
		// falls short exactly where it should reach furthest
		const corner = [[0, 0], [50, 0], [50, 50]];
		const { points } = offsetAlongNormals(corner, 4, { side: Side.RIGHT, tolerance: 0.01 });

		expect(points.length).toBeGreaterThan(10);
		for (const point of points)
			expect(distanceToPath(point, corner)).toBeGreaterThan(4 - 0.02);
	});

	it('mitres an inward corner to a single point', () => {
		const corner = [[0, 0], [50, 0], [50, 50]];
		const { raw } = offsetAlongNormals(corner, 4, { side: Side.LEFT, clean: 0 });
		expect(raw).toHaveLength(3);
		expect(raw[1][0]).toBeCloseTo(46, 6);
		expect(raw[1][1]).toBeCloseTo(4, 6);
	});
});


describe('normal offset — folding, and the clean control', () => {

	// radius of curvature far below the offset distance, so the inside of every
	// bend folds over itself
	const tight = wave(9, 12, 120);

	it('folds without cleaning', () => {
		expect(peakRadius(9, 12)).toBeLessThan(0.5);

		const { points } = offsetAlongNormals(tight, 1.5, { side: Side.LEFT, clean: 0 });

		const strays = points.filter((p) => distanceToPath(p, tight) < 1.4);
		expect(strays.length).toBeGreaterThan(0);
	});

	it('removes every folded point at full clean', () => {
		const { points, removed } = offsetAlongNormals(tight, 1.5, { side: Side.LEFT, clean: 1 });

		expect(removed).toBeGreaterThan(0);

		// the guarantee: nothing survives that came closer than the offset distance
		for (const point of points)
			expect(distanceToPath(point, tight)).toBeGreaterThanOrEqual(1.5 - 1e-6);
	});

	it('removes more as the clean control rises', () => {
		const counts = [0, 0.5, 0.9, 1].map(
			(clean) => offsetAlongNormals(tight, 1.5, { side: Side.LEFT, clean }).removed,
		);

		for (let i = 1; i < counts.length; i++)
			expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);

		expect(counts[0]).toBe(0);
		expect(counts[counts.length - 1]).toBeGreaterThan(0);
	});

	it('keeps the outward side intact while cleaning the inward one', () => {
		// the outside of a bend spreads apart rather than folding, so cleaning
		// should have essentially nothing to do there
		const inward = offsetAlongNormals(tight, 1.5, { side: Side.LEFT, clean: 1 });
		const outward = offsetAlongNormals(tight, 1.5, { side: Side.RIGHT, clean: 1 });

		// both sides of a symmetric wave fold, but a one-sided bend should not
		const arch = [[0, 0], [20, 12], [40, 0], [60, 0]];
		const outer = offsetAlongNormals(arch, 1.5, { side: Side.RIGHT, clean: 1 });
		expect(outer.removed).toBe(0);

		expect(inward.points.length).toBeGreaterThan(0);
		expect(outward.points.length).toBeGreaterThan(0);
	});

	it('still returns the uncleaned path, for comparison', () => {
		const result = offsetAlongNormals(tight, 1.5, { side: Side.LEFT, clean: 1 });
		expect(result.raw.length).toBeGreaterThan(result.points.length);
	});

	it('has a sane default clean', () => {
		expect(DEFAULT_CLEAN).toBeGreaterThan(0);
		expect(DEFAULT_CLEAN).toBeLessThanOrEqual(1);
	});
});


describe('degenerate input', () => {

	it('rejects a non-positive distance', () => {
		expect(() => offsetAlongNormals([[0, 0], [1, 0]], 0)).toThrow(RangeError);
		expect(() => offsetAlongNormals([[0, 0], [1, 0]], -2)).toThrow(RangeError);
	});

	it('returns nothing for a path with no length', () => {
		expect(offsetAlongNormals([], 1).points).toEqual([]);
		expect(offsetAlongNormals([[5, 5]], 1).points).toEqual([]);
		expect(offsetAlongNormals([[5, 5], [5, 5], [5, 5]], 1).points).toEqual([]);
	});

	it('ignores repeated points, which have no direction', () => {
		const withDupes = [[0, 0], [0, 0], [50, 0], [50, 0]];
		const { points } = offsetAlongNormals(withDupes, 2, { side: Side.LEFT });
		expect(points.every(([, y]) => Math.abs(y - 2) < 1e-9)).toBe(true);
	});

	it('survives a complete reversal without producing infinities', () => {
		// the mitre at a 180 degree turn is at infinity; the fallback must catch it
		const spike = [[0, 0], [50, 0], [0, 0.001]];
		const { raw } = offsetAlongNormals(spike, 3, { side: Side.LEFT, clean: 0 });
		expect(raw.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
	});
});


describe('resample', () => {

	it('spaces points evenly and keeps both ends', () => {
		const out = resample([[0, 0], [10, 0]], 2);
		expect(out[0]).toEqual([0, 0]);
		expect(out[out.length - 1]).toEqual([10, 0]);

		for (let i = 1; i < out.length - 1; i++)
			expect(Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1])).toBeCloseTo(2, 6);
	});

	it('carries spacing across segment boundaries rather than restarting', () => {
		const out = resample([[0, 0], [3, 0], [6, 0]], 2);
		const gaps = [];
		for (let i = 1; i < out.length; i++)
			gaps.push(Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));

		// every gap except the final short one should be the requested spacing
		for (const gap of gaps.slice(0, -1))
			expect(gap).toBeCloseTo(2, 6);
	});

	it('rejects a non-positive spacing', () => {
		expect(() => resample([[0, 0], [1, 0]], 0)).toThrow(RangeError);
	});

	it('passes through a path too short to resample', () => {
		expect(resample([[1, 2]], 5)).toEqual([[1, 2]]);
	});
});
