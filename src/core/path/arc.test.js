import { describe, it, expect } from 'vitest';
import { endpointToCentre, arcPoint, arcAngularStep, flattenArc } from './arc.js';

const TAU = Math.PI * 2;

/** Distance from a point to the arc's centre, along the arc's own axes. */
const onEllipse = (arc, point) => {
	const dx = point[0] - arc.centre[0];
	const dy = point[1] - arc.centre[1];
	const cos = Math.cos(-arc.rotation);
	const sin = Math.sin(-arc.rotation);
	const lx = (dx * cos) - (dy * sin);
	const ly = (dx * sin) + (dy * cos);
	return ((lx * lx) / (arc.rx * arc.rx)) + ((ly * ly) / (arc.ry * arc.ry));
};


describe('endpointToCentre', () => {

	it('finds the centre of a simple quarter circle', () => {
		// from (0,10) to (10,0), sweeping clockwise about the origin
		const arc = endpointToCentre([0, 10], 10, 10, 0, false, false, [10, 0]);
		expect(arc.centre[0]).toBeCloseTo(0, 9);
		expect(arc.centre[1]).toBeCloseTo(0, 9);
		expect(arc.rx).toBeCloseTo(10, 9);
		expect(Math.abs(arc.deltaAngle)).toBeCloseTo(Math.PI / 2, 9);
	});

	it('puts both endpoints exactly on the ellipse', () => {
		const cases = [
			[[0, 0], 10, 10, 0, false, true, [10, 10]],
			[[5, 5], 30, 12, 37, true, false, [40, 25]],
			[[-8, 3], 6, 6, 0, true, true, [4, -9]],
		];

		for (const [from, rx, ry, rot, large, sweep, to] of cases) {
			const arc = endpointToCentre(from, rx, ry, rot, large, sweep, to);
			expect(arc).not.toBeNull();
			expect(onEllipse(arc, from)).toBeCloseTo(1, 6);
			expect(onEllipse(arc, to)).toBeCloseTo(1, 6);
		}
	});

	it('reproduces the endpoints when evaluated at its own angles', () => {
		const from = [5, 5];
		const to = [40, 25];
		const arc = endpointToCentre(from, 30, 12, 37, true, false, to);

		const start = arcPoint(arc, arc.startAngle);
		const end = arcPoint(arc, arc.startAngle + arc.deltaAngle);

		expect(start[0]).toBeCloseTo(from[0], 6);
		expect(start[1]).toBeCloseTo(from[1], 6);
		expect(end[0]).toBeCloseTo(to[0], 6);
		expect(end[1]).toBeCloseTo(to[1], 6);
	});

	it('honours the large-arc flag', () => {
		const small = endpointToCentre([0, 0], 10, 10, 0, false, true, [10, 10]);
		const large = endpointToCentre([0, 0], 10, 10, 0, true, true, [10, 10]);
		expect(Math.abs(small.deltaAngle)).toBeLessThan(Math.PI);
		expect(Math.abs(large.deltaAngle)).toBeGreaterThan(Math.PI);
	});

	it('honours the sweep flag by reversing direction', () => {
		const cw = endpointToCentre([0, 0], 10, 10, 0, false, false, [10, 10]);
		const ccw = endpointToCentre([0, 0], 10, 10, 0, false, true, [10, 10]);
		expect(Math.sign(cw.deltaAngle)).toBe(-Math.sign(ccw.deltaAngle));
	});

	it('scales up radii too small to span the endpoints, per spec', () => {
		// 1,1 cannot reach from (0,0) to (10,0); the spec says enlarge, not reject
		const arc = endpointToCentre([0, 0], 1, 1, 0, false, true, [10, 0]);
		expect(arc).not.toBeNull();
		expect(arc.rx).toBeCloseTo(5, 9);
		expect(arc.ry).toBeCloseTo(5, 9);
	});

	it('reports degenerate arcs as null so the caller can emit a line', () => {
		expect(endpointToCentre([0, 0], 0, 10, 0, false, true, [10, 10])).toBeNull();
		expect(endpointToCentre([0, 0], 10, 0, 0, false, true, [10, 10])).toBeNull();
		expect(endpointToCentre([5, 5], 10, 10, 0, false, true, [5, 5])).toBeNull();
	});

	it('treats a negative radius as its magnitude', () => {
		const a = endpointToCentre([0, 0], -10, -10, 0, false, true, [10, 10]);
		expect(a.rx).toBeCloseTo(10, 9);
		expect(a.ry).toBeCloseTo(10, 9);
	});
});


describe('arcAngularStep', () => {

	it('derives the step from the sagitta, exactly', () => {
		const arc = { rx: 100, ry: 100, centre: [0, 0], rotation: 0, startAngle: 0, deltaAngle: TAU };
		const tolerance = 0.01;
		const step = arcAngularStep(arc, tolerance);

		// sagitta of a chord spanning `step` must equal the tolerance
		expect(100 * (1 - Math.cos(step / 2))).toBeCloseTo(tolerance, 9);
	});

	it('takes smaller steps on tighter radii', () => {
		const mk = (r) => ({ rx: r, ry: r, centre: [0, 0], rotation: 0, startAngle: 0, deltaAngle: TAU });
		expect(arcAngularStep(mk(200), 0.01)).toBeLessThan(arcAngularStep(mk(2), 0.01));
	});
});


describe('flattenArc', () => {

	it('keeps every point within tolerance of the true circle', () => {
		for (const radius of [0.5, 5, 50, 500]) {
			const arc = endpointToCentre([radius, 0], radius, radius, 0, true, true, [-radius, 0]);
			const tolerance = 0.01;
			const points = flattenArc(arc, [-radius, 0], tolerance);

			for (const [x, y] of points.slice(0, -1)) {
				const err = Math.abs(Math.hypot(x, y) - radius);
				expect(err, `radius ${radius}`).toBeLessThanOrEqual(tolerance);
			}
		}
	});

	it('lands exactly on the given endpoint, not an evaluated one', () => {
		// consecutive segments must join without a floating point gap
		const to = [40, 25];
		const arc = endpointToCentre([5, 5], 30, 12, 37, true, false, to);
		const points = flattenArc(arc, to, 0.01);
		expect(points[points.length - 1]).toEqual(to);
	});

	it('never emits the start point', () => {
		const arc = endpointToCentre([10, 0], 10, 10, 0, false, true, [0, 10]);
		const points = flattenArc(arc, [0, 10], 0.01);
		expect(points[0][0]).not.toBeCloseTo(10, 6);
	});

	it('emits more points as the tolerance tightens', () => {
		const arc = endpointToCentre([50, 0], 50, 50, 0, true, true, [-50, 0]);
		const coarse = flattenArc(arc, [-50, 0], 1).length;
		const fine = flattenArc(arc, [-50, 0], 0.001).length;
		expect(fine).toBeGreaterThan(coarse);
	});
});
