import { describe, it, expect } from 'vitest';
import {
	flattenSubPath,
	flattenSubPaths,
	evaluateCubic,
	cubicFlatnessBound,
	DEFAULT_FLATTEN_TOLERANCE,
} from './flatten.js';
import { normalizePathData } from './normalize.js';
import { circleToPath, ellipseToPath } from '../svg/primitives.js';

/** Perpendicular distance from a point to a finite segment. */
const pointToSegment = (p, a, b) => {
	const vx = b[0] - a[0];
	const vy = b[1] - a[1];
	const lengthSq = (vx * vx) + (vy * vy);

	if (lengthSq === 0)
		return Math.hypot(p[0] - a[0], p[1] - a[1]);

	let t = (((p[0] - a[0]) * vx) + ((p[1] - a[1]) * vy)) / lengthSq;
	t = Math.max(0, Math.min(1, t));

	return Math.hypot(p[0] - (a[0] + (t * vx)), p[1] - (a[1] + (t * vy)));
};

/** Largest distance from any point on the polyline's source curves to the polyline. */
const maxDeviation = (subPath, points, samplesPerSegment = 400) => {
	let worst = 0;
	let cursor = subPath.start;

	for (const segment of subPath.segments) {
		if (segment.type === 'C') {
			for (let i = 0; i <= samplesPerSegment; i++) {
				const onCurve = evaluateCubic(cursor, segment.c1, segment.c2, segment.to, i / samplesPerSegment);

				let nearest = Infinity;
				for (let k = 0; k + 1 < points.length; k++)
					nearest = Math.min(nearest, pointToSegment(onCurve, points[k], points[k + 1]));

				worst = Math.max(worst, nearest);
			}
		}
		cursor = segment.to;
	}

	return worst;
};

/** A fake element, so we can reuse the primitive converters. */
const el = (nodeName, attrs) => ({
	nodeName,
	getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? String(attrs[k]) : null),
});


describe('lines', () => {

	it('never subdivides a straight line, at any tolerance', () => {
		const { subPaths } = normalizePathData('M0 0 L100 0 L100 100');
		for (const tolerance of [1, 0.01, 0.000001]) {
			const { points } = flattenSubPath(subPaths[0], { tolerance });
			expect(points).toHaveLength(3);
		}
	});
});


describe('deviation is actually bounded — the property jscut cannot offer', () => {

	it('keeps a flattened circle within tolerance of its true radius', () => {
		const d = circleToPath(el('circle', { cx: 0, cy: 0, r: 50 }));
		const { subPaths } = normalizePathData(d);
		const tolerance = 0.01;
		const { points } = flattenSubPath(subPaths[0], { tolerance });

		for (const [x, y] of points) {
			const radialError = Math.abs(Math.hypot(x, y) - 50);
			expect(radialError).toBeLessThanOrEqual(tolerance);
		}
	});

	it('holds the SAME tolerance on a huge arc and a tiny one', () => {
		// this is the jscut failure mode: its chord-length rule gives a 200-unit
		// arc and a 2-unit arc wildly different fidelity from one setting
		const tolerance = 0.01;

		for (const radius of [0.5, 2, 50, 200, 1000]) {
			const d = circleToPath(el('circle', { cx: 0, cy: 0, r: radius }));
			const { subPaths } = normalizePathData(d);
			const { points } = flattenSubPath(subPaths[0], { tolerance });

			let worst = 0;
			for (const [x, y] of points)
				worst = Math.max(worst, Math.abs(Math.hypot(x, y) - radius));

			expect(worst, `radius ${radius}`).toBeLessThanOrEqual(tolerance);
		}
	});

	it('bounds deviation on a general cubic, measured against the true curve', () => {
		const { subPaths } = normalizePathData('M0 0 C 30 120, 90 -60, 120 40');
		const tolerance = 0.005;
		const { points } = flattenSubPath(subPaths[0], { tolerance });

		expect(maxDeviation(subPaths[0], points)).toBeLessThanOrEqual(tolerance);
	});

	it('bounds deviation on an ellipse under a squashed aspect', () => {
		const d = ellipseToPath(el('ellipse', { cx: 10, cy: -5, rx: 80, ry: 6 }));
		const { subPaths } = normalizePathData(d);
		const tolerance = 0.02;
		const { points } = flattenSubPath(subPaths[0], { tolerance });

		expect(maxDeviation(subPaths[0], points)).toBeLessThanOrEqual(tolerance);
	});

	it('spends points only where curvature needs them', () => {
		const tight = normalizePathData('M0 0 C 0 40, 40 40, 40 0');
		const gentle = normalizePathData('M0 0 C 40 2, 80 2, 120 0');

		const a = flattenSubPath(tight.subPaths[0], { tolerance: 0.01 }).points.length;
		const b = flattenSubPath(gentle.subPaths[0], { tolerance: 0.01 }).points.length;

		expect(a).toBeGreaterThan(b);
	});

	it('produces more points as the tolerance tightens', () => {
		const { subPaths } = normalizePathData('M0 0 C 30 120, 90 -60, 120 40');

		const coarse = flattenSubPath(subPaths[0], { tolerance: 1 }).points.length;
		const fine = flattenSubPath(subPaths[0], { tolerance: 0.001 }).points.length;

		expect(fine).toBeGreaterThan(coarse);
	});
});


describe('flatness bound', () => {

	it('is zero for a cubic that is already a straight line', () => {
		const bound = cubicFlatnessBound([0, 0], [10, 0], [20, 0], [30, 0]);
		expect(bound).toBeCloseTo(0, 12);
	});

	it('is never smaller than the true deviation', () => {
		// a bound that under-reports would let real error exceed the tolerance
		const p0 = [0, 0], c1 = [0, 60], c2 = [60, 60], p3 = [60, 0];
		const bound = cubicFlatnessBound(p0, c1, c2, p3);

		let trueMax = 0;
		for (let i = 0; i <= 500; i++) {
			const t = i / 500;
			const point = evaluateCubic(p0, c1, c2, p3, t);
			trueMax = Math.max(trueMax, pointToSegment(point, p0, p3));
		}

		expect(bound).toBeGreaterThanOrEqual(trueMax);
	});
});


describe('closed polylines', () => {

	it('carries no duplicate closing point', () => {
		const { subPaths } = normalizePathData('M0 0 L10 0 L10 10 Z');
		const { points, closed } = flattenSubPath(subPaths[0], { tolerance: 0.01 });

		expect(closed).toBe(true);
		expect(points).toHaveLength(3);
		expect(points[0]).not.toEqual(points[points.length - 1]);
	});

	it('keeps both distinct endpoints of an open path', () => {
		const { subPaths } = normalizePathData('M0 0 L10 0 L10 10');
		const { points, closed } = flattenSubPath(subPaths[0], { tolerance: 0.01 });

		expect(closed).toBe(false);
		expect(points).toHaveLength(3);
		expect(points[0]).toEqual([0, 0]);
		expect(points[2]).toEqual([10, 10]);
	});
});


describe('inputs and options', () => {

	it('rejects a non-positive tolerance rather than looping forever', () => {
		const { subPaths } = normalizePathData('M0 0 C1 1 2 1 3 0');
		expect(() => flattenSubPath(subPaths[0], { tolerance: 0 })).toThrow(RangeError);
		expect(() => flattenSubPath(subPaths[0], { tolerance: -1 })).toThrow(RangeError);
	});

	it('survives a fully degenerate cubic', () => {
		const { subPaths } = normalizePathData('M5 5 C5 5 5 5 5 5');
		const { points } = flattenSubPath(subPaths[0], { tolerance: 0.01 });
		expect(points.length).toBeGreaterThanOrEqual(1);
		expect(points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
	});

	it('flattens every subpath in a document', () => {
		const { subPaths } = normalizePathData('M0 0 L10 0 Z M20 20 C25 25 30 25 35 20');
		const flat = flattenSubPaths(subPaths, { tolerance: 0.01 });

		expect(flat).toHaveLength(2);
		expect(flat[0].closed).toBe(true);
		expect(flat[1].closed).toBe(false);
	});

	it('has a sane default tolerance', () => {
		expect(DEFAULT_FLATTEN_TOLERANCE).toBeGreaterThan(0);
		expect(DEFAULT_FLATTEN_TOLERANCE).toBeLessThan(0.1);
	});
});
