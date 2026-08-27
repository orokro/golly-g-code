import { describe, it, expect } from 'vitest';
import { computeDepthPasses, describeThroughCut } from './depth.js';

describe('computeDepthPasses', () => {

	it('divides evenly when it can', () => {
		expect(computeDepthPasses(6, 2)).toEqual([-2, -4, -6]);
	});

	it('lands the final pass exactly on target rather than overshooting', () => {
		// cutting 0.5mm deeper than asked because 10 does not divide by 3 would be
		// a real mistake, not a rounding detail
		const passes = computeDepthPasses(10, 3);
		expect(passes).toHaveLength(4);
		expect(passes[passes.length - 1]).toBeCloseTo(-10, 9);
		expect(Math.min(...passes)).toBeGreaterThanOrEqual(-10);
	});

	it('never exceeds the pass depth on any single pass', () => {
		const passes = computeDepthPasses(10, 3);
		let previous = 0;
		for (const z of passes) {
			expect(previous - z).toBeLessThanOrEqual(3 + 1e-9);
			previous = z;
		}
	});

	it('makes one pass when the cut fits in one', () => {
		expect(computeDepthPasses(2, 5)).toEqual([-2]);
		expect(computeDepthPasses(3, 3)).toEqual([-3]);
	});

	it('honours a material surface above zero', () => {
		expect(computeDepthPasses(4, 2, { topZ: 10 })).toEqual([8, 6]);
	});

	it('rejects non-positive depths', () => {
		expect(() => computeDepthPasses(0, 1)).toThrow(RangeError);
		expect(() => computeDepthPasses(-5, 1)).toThrow(RangeError);
		expect(() => computeDepthPasses(5, 0)).toThrow(RangeError);
		expect(() => computeDepthPasses(5, -1)).toThrow(RangeError);
	});

	it('refuses an absurd number of passes instead of hanging', () => {
		expect(() => computeDepthPasses(100, 1e-9)).toThrow(RangeError);
	});
});


describe('describeThroughCut', () => {

	it('reports a cut that stops short', () => {
		const r = describeThroughCut(10, 18);
		expect(r.cutsThrough).toBe(false);
		expect(r.overshoot).toBeCloseTo(-8, 9);
	});

	it('reports a cut that goes through', () => {
		const r = describeThroughCut(19, 18);
		expect(r.cutsThrough).toBe(true);
		expect(r.overshoot).toBeCloseTo(1, 9);
	});

	it('treats a deliberate allowance as expected, not as a problem', () => {
		// cutting into a prepared spoilboard groove is a real technique, not a bug
		expect(describeThroughCut(19, 18, 2).beyondAllowance).toBe(false);
		expect(describeThroughCut(21, 18, 2).beyondAllowance).toBe(true);
	});
});
