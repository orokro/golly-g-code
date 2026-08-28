import { describe, it, expect } from 'vitest';
import { fitArcs, fitError, circleThrough } from './fit.js';

/** A circular arc sampled as a polyline, the way an offset would leave one. */
const sampleArc = (cx, cy, radius, fromAngle, toAngle, steps = 200) => {
	const pts = [];
	for (let i = 0; i <= steps; i++) {
		const a = fromAngle + ((toAngle - fromAngle) * (i / steps));
		pts.push([cx + (radius * Math.cos(a)), cy + (radius * Math.sin(a))]);
	}
	return pts;
};

const wave = (amplitude, wavelength, width = 200, step = 0.25) => {
	const pts = [];
	for (let x = 0; x <= width; x += step)
		pts.push([x, amplitude * Math.sin((2 * Math.PI * x) / wavelength)]);
	return pts;
};


describe('the circle through three points', () => {

	it('finds a known circle', () => {
		const { centre, radius } = circleThrough([1, 0], [0, 1], [-1, 0]);
		expect(centre[0]).toBeCloseTo(0, 9);
		expect(centre[1]).toBeCloseTo(0, 9);
		expect(radius).toBeCloseTo(1, 9);
	});

	it('returns nothing for collinear points rather than a vast circle', () => {
		expect(circleThrough([0, 0], [1, 0], [2, 0])).toBeNull();
	});
});


describe('fitting', () => {

	it('describes a straight line as one line', () => {
		const points = [];
		for (let x = 0; x <= 100; x += 0.5)
			points.push([x, 0]);

		const segments = fitArcs(points);
		expect(segments).toHaveLength(1);
		expect(segments[0].type).toBe('line');
		expect(segments[0].to).toEqual([100, 0]);
	});

	it('describes a semicircle as arcs, not two hundred lines', () => {
		const points = sampleArc(0, 0, 20, 0, Math.PI);
		const segments = fitArcs(points, { tolerance: 0.01 });

		expect(segments.length).toBeLessThanOrEqual(2);
		expect(segments.every((s) => s.type === 'arc')).toBe(true);
		for (const segment of segments)
			expect(segment.radius).toBeCloseTo(20, 3);
	});

	it('gets the direction right, both ways round', () => {
		expect(fitArcs(sampleArc(0, 0, 20, 0, Math.PI / 2))[0].clockwise).toBe(false);
		expect(fitArcs(sampleArc(0, 0, 20, Math.PI / 2, 0))[0].clockwise).toBe(true);
	});

	it('splits rather than emitting a sweep it cannot describe unambiguously', () => {
		// beyond half a turn, which way round stops being inferable from the
		// endpoints and centre, and controllers disagree
		const segments = fitArcs(sampleArc(0, 0, 15, 0, 2 * Math.PI - 0.01), { tolerance: 0.01 });
		expect(segments.length).toBeGreaterThan(1);
		for (const segment of segments)
			if (segment.type === 'arc')
				expect(segment.sweep).toBeLessThanOrEqual(Math.PI + 1e-9);
	});

	it('keeps every original point within tolerance, measured independently', () => {
		for (const tolerance of [0.005, 0.01, 0.05]) {
			const points = wave(9, 40, 200, 0.2);
			const segments = fitArcs(points, { tolerance });
			expect(fitError(points, segments), `${tolerance}`).toBeLessThanOrEqual(tolerance + 1e-9);
		}
	});

	it('refuses to call a path that doubles back an arc', () => {
		// out and home along the same curve: every point sits at the same radius,
		// so a distance test alone passes while the arc describes a different
		// journey entirely
		const out = sampleArc(0, 0, 20, 0, Math.PI / 2, 40);
		const points = [...out, ...out.slice(0, -1).reverse()];
		const segments = fitArcs(points, { tolerance: 0.01 });

		expect(fitError(points, segments)).toBeLessThanOrEqual(0.01 + 1e-9);
		// it must break at the turn rather than sweeping through it
		expect(segments.length).toBeGreaterThan(1);
	});

	it('does not invent a huge circle for a nearly straight run', () => {
		const points = [];
		for (let x = 0; x <= 100; x += 0.5)
			points.push([x, x * 1e-6]);

		for (const segment of fitArcs(points, { tolerance: 0.01 }))
			expect(segment.type).toBe('line');
	});

	it('leaves a two-point path alone', () => {
		const segments = fitArcs([[0, 0], [10, 10]]);
		expect(segments).toEqual([{ type: 'line', to: [10, 10] }]);
	});

	it('returns nothing for a path with no length', () => {
		expect(fitArcs([[1, 1]])).toEqual([]);
		expect(fitArcs([])).toEqual([]);
	});

	it('rejects a non-positive tolerance', () => {
		expect(() => fitArcs([[0, 0], [1, 0]], { tolerance: 0 })).toThrow(RangeError);
	});
});


describe('how much it actually saves', () => {

	it('turns thousands of chords into a handful of blocks', () => {
		const points = wave(9, 40, 200, 0.05);
		const segments = fitArcs(points, { tolerance: 0.01 });

		expect(points.length).toBeGreaterThan(3000);
		expect(segments.length).toBeLessThan(points.length / 20);
		expect(fitError(points, segments)).toBeLessThanOrEqual(0.01 + 1e-9);
	});

	it('tightening the tolerance costs blocks, and never breaks the promise', () => {
		const points = wave(9, 40, 200, 0.05);
		const loose = fitArcs(points, { tolerance: 0.05 });
		const tight = fitArcs(points, { tolerance: 0.002 });

		expect(tight.length).toBeGreaterThan(loose.length);
		expect(fitError(points, tight)).toBeLessThanOrEqual(0.002 + 1e-9);
		expect(fitError(points, loose)).toBeLessThanOrEqual(0.05 + 1e-9);
	});
});


describe('an arc must follow the path between the points, not just through them', () => {

	// Any three points lie on a circle, so a fit through three points verifies
	// nothing. A right-angled corner IS three points. On Greg's skyline this
	// turned a corner into a semicircle bulging 5.15mm off the path, with every
	// vertex sitting exactly on it — found by reading the emitted G-code back
	// and tracing it, which is the only check that could have caught it.

	it('does not turn a right-angled corner into a semicircle', () => {
		const corner = [[110.52, 270.14], [110.52, 255.625], [115.587, 255.625]];
		const segments = fitArcs(corner, { tolerance: 0.01 });

		expect(segments.every((s) => s.type === 'line')).toBe(true);
		expect(fitError(corner, segments)).toBeLessThanOrEqual(0.01 + 1e-9);
	});

	it('rejects any three points that only happen to share a circle', () => {
		// a wide V: the circle through its three points bows far from both legs
		for (const apex of [[10, 0], [10, -5], [10, -20]]) {
			const v = [[0, 0], apex, [20, 0]];
			expect(fitArcs(v, { tolerance: 0.01 }).every((s) => s.type === 'line'),
				`${apex}`).toBe(true);
		}
	});

	it('still fits a genuine arc that happens to be coarsely sampled', () => {
		// densely enough that the chords hug the circle, which is the real
		// difference between this and a corner
		const points = [];
		for (let i = 0; i <= 60; i++) {
			const a = (Math.PI / 2) * (i / 60);
			points.push([50 * Math.cos(a), 50 * Math.sin(a)]);
		}
		const segments = fitArcs(points, { tolerance: 0.05 });
		expect(segments.some((s) => s.type === 'arc')).toBe(true);
		expect(fitError(points, segments)).toBeLessThanOrEqual(0.05 + 1e-9);
	});

	it('stops short of a half turn, where the direction is not recoverable', () => {
		const points = [];
		for (let i = 0; i <= 400; i++) {
			const a = Math.PI * (i / 400);
			points.push([20 * Math.cos(a), 20 * Math.sin(a)]);
		}
		for (const segment of fitArcs(points, { tolerance: 0.01 }))
			if (segment.type === 'arc')
				expect(segment.sweep).toBeLessThan(Math.PI);
	});
});
