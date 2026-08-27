import { describe, it, expect } from 'vitest';
import {
	SCALE, MAX_SAFE_MILLIMETERS, OpenEnd, Join,
	offsetClosed, offsetOpen, offsetSeries,
	union, intersection, difference, xor, normalize,
	signedArea, isClockwise, reverse,
} from './clipper.js';

/** A counter-clockwise rectangle, no duplicate closing point. */
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

const boundsOf = (polygons) => {
	const pts = polygons.flat();
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};

const totalArea = (polygons) => polygons.reduce((sum, p) => sum + Math.abs(signedArea(p)), 0);

/**
 * Enclosed area, counting holes as negative.
 *
 * Clipper represents a hole as a separate path wound the opposite way to its
 * outer, so summing SIGNED areas is what actually measures material. Summing
 * absolute areas counts a hole as if it were solid.
 */
const netArea = (polygons) => Math.abs(polygons.reduce((sum, p) => sum + signedArea(p), 0));


describe('input validation', () => {

	it('rejects coordinates beyond Clipper\'s exact range', () => {
		// Clipper does not complain itself; it silently loses precision
		const huge = rect(0, 0, MAX_SAFE_MILLIMETERS * 2, 10);
		expect(() => offsetClosed([huge], 1)).toThrow(RangeError);
	});

	it('accepts a workspace-sized part comfortably', () => {
		// a 1200mm bed leaves roughly 4x headroom
		expect(() => offsetClosed([rect(0, 0, 1200, 1200)], 3)).not.toThrow();
	});

	it('rejects non-finite coordinates', () => {
		expect(() => offsetClosed([[[0, 0], [NaN, 1], [2, 2]]], 1)).toThrow(RangeError);
		expect(() => offsetClosed([[[0, 0], [Infinity, 1], [2, 2]]], 1)).toThrow(RangeError);
	});

	it('filters degenerate polygons rather than throwing a raw library error', () => {
		// a one-point path makes clipper2-ts throw "Cannot read properties of null"
		expect(() => offsetClosed([[[5, 5]]], 1)).not.toThrow();
		expect(offsetClosed([[[5, 5]]], 1)).toEqual([]);
		expect(offsetClosed([], 1)).toEqual([]);
	});

	it('pins the scale factor', () => {
		expect(SCALE).toBe(10_000);
		expect(MAX_SAFE_MILLIMETERS).toBeCloseTo(4745.3132, 4);
	});
});


describe('closed offsets', () => {

	it('grows a square outward', () => {
		const b = boundsOf(offsetClosed([rect(0, 0, 10, 10)], 2));
		expect(b.minX).toBeCloseTo(-2, 2);
		expect(b.maxX).toBeCloseTo(12, 2);
	});

	it('shrinks a square inward', () => {
		const result = offsetClosed([rect(0, 0, 10, 10)], -2);
		const b = boundsOf(result);
		expect(result).toHaveLength(1);
		expect(b.minX).toBeCloseTo(2, 6);
		expect(b.maxX).toBeCloseTo(8, 6);
	});

	it('vanishes a shape smaller than the inward offset', () => {
		// clipper2-js gets this wrong and returns a path; this is why we do not use it
		expect(offsetClosed([rect(0, 0, 15, 15)], -10)).toEqual([]);
	});

	it('treats a hole correctly when offset alongside its outer', () => {
		// winding tells Clipper which is which, so they must go in one call
		const outer = rect(0, 0, 40, 40);
		const hole = reverse(rect(10, 10, 20, 20));

		const grown = offsetClosed([outer, hole], 2);
		expect(grown).toHaveLength(2);

		// the outer grows AND the hole shrinks, so material increases from both
		// directions: 40x40 less 20x20 = 1200, becoming roughly 44x44 less 16x16
		expect(netArea([outer, hole])).toBeCloseTo(1200, 6);
		expect(netArea(grown)).toBeGreaterThan(1600);
	});

	it('supports miter and square joins as well as round', () => {
		const round = offsetClosed([rect(0, 0, 10, 10)], 2, { join: Join.ROUND });
		const miter = offsetClosed([rect(0, 0, 10, 10)], 2, { join: Join.MITER });

		// a mitred corner is a single sharp point; a round one is many
		expect(miter[0].length).toBeLessThan(round[0].length);

		// and a mitred outward offset therefore encloses more area
		expect(totalArea(miter)).toBeGreaterThan(totalArea(round));
	});

	it('can compensate for arcs being inscribed', () => {
		// the polygonal arc always falls inside the true one, so an outward offset
		// is fractionally undersized; this matters where clearance is real
		const plain = offsetClosed([rect(0, 0, 10, 10)], 2, { toleranceMm: 0.05 });
		const nudged = offsetClosed([rect(0, 0, 10, 10)], 2, {
			toleranceMm: 0.05, compensateInscribedArcs: true,
		});
		expect(totalArea(nudged)).toBeGreaterThan(totalArea(plain));
	});

	it('spends more points at a tighter arc tolerance', () => {
		const coarse = offsetClosed([rect(0, 0, 10, 10)], 2, { toleranceMm: 0.5 });
		const fine = offsetClosed([rect(0, 0, 10, 10)], 2, { toleranceMm: 0.001 });
		expect(fine[0].length).toBeGreaterThan(coarse[0].length);
	});
});


describe('open path offsets — what jscut cannot do at all', () => {

	const elbow = [[0, 0], [20, 0], [20, 20]];

	it('turns an open polyline into one closed outline', () => {
		for (const end of [OpenEnd.BUTT, OpenEnd.SQUARE, OpenEnd.ROUND]) {
			const result = offsetOpen([elbow], 3, { end });
			expect(result, end).toHaveLength(1);
			expect(result[0].length, end).toBeGreaterThan(3);
		}
	});

	it('extends the outline past the ends for square and round caps, but not butt', () => {
		const butt = boundsOf(offsetOpen([elbow], 3, { end: OpenEnd.BUTT }));
		const round = boundsOf(offsetOpen([elbow], 3, { end: OpenEnd.ROUND }));

		// a butt cap stops dead at x=0; a round cap reaches a tool radius beyond
		expect(butt.minX).toBeCloseTo(0, 2);
		expect(round.minX).toBeCloseTo(-3, 1);
	});

	it('treats a lone point as a disc, which is what a drilled dot is', () => {
		const disc = offsetOpen([[[5, 5]]], 2, { end: OpenEnd.ROUND });
		expect(disc).toHaveLength(1);
		expect(totalArea(disc)).toBeCloseTo(Math.PI * 4, 0);
	});

	it('refuses a non-positive offset instead of returning nonsense', () => {
		expect(() => offsetOpen([elbow], 0)).toThrow(RangeError);
		expect(() => offsetOpen([elbow], -3)).toThrow(RangeError);
	});

	it('rejects an unknown cap style', () => {
		expect(() => offsetOpen([elbow], 3, { end: 'pointy' })).toThrow(TypeError);
	});
});


describe('booleans', () => {

	const a = rect(0, 0, 10, 10);
	const b = rect(5, 5, 10, 10);

	it('unions overlapping squares into one shape', () => {
		const result = union([a], [b]);
		expect(result).toHaveLength(1);
		expect(totalArea(result)).toBeCloseTo(175, 6);
	});

	it('intersects them to the overlap', () => {
		expect(totalArea(intersection([a], [b]))).toBeCloseTo(25, 6);
	});

	it('subtracts one from the other', () => {
		expect(totalArea(difference([a], [b]))).toBeCloseTo(75, 6);
	});

	it('xors to both non-overlapping parts', () => {
		const result = xor([a], [b]);
		expect(result).toHaveLength(2);
		expect(totalArea(result)).toBeCloseTo(150, 6);
	});

	it('honours the fill rule for nested shapes', () => {
		const outer = rect(0, 0, 30, 30);
		const inner = rect(10, 10, 10, 10);

		// Both wound the same way. Even-odd makes the inner square a hole;
		// non-zero absorbs it into the solid outer.
		const evenOdd = union([outer, inner], [], 'evenodd');
		const nonZero = union([outer, inner], [], 'nonzero');

		// A hole comes back as a SEPARATE path wound the opposite way to its
		// outer -- that is how Clipper states holes, and downstream code
		// (pocket clearing, cut direction) has to read winding to tell them apart.
		expect(evenOdd).toHaveLength(2);
		expect(isClockwise(evenOdd[0])).toBe(false);
		expect(isClockwise(evenOdd[1])).toBe(true);
		expect(netArea(evenOdd)).toBeCloseTo(800, 6);

		// non-zero leaves one path: the inner contributes nothing
		expect(nonZero).toHaveLength(1);
		expect(netArea(nonZero)).toBeCloseTo(900, 6);
	});

	it('rejects an unknown fill rule', () => {
		expect(() => union([a], [], 'sometimes')).toThrow(TypeError);
	});
});


describe('normalize — required before offsetting real artwork', () => {

	it('resolves a self-intersecting bowtie into clean geometry', () => {
		// offsetting this directly produces spurious slivers
		const bowtie = [[0, 0], [10, 10], [10, 0], [0, 10]];

		const direct = offsetClosed([bowtie], 1);
		const cleaned = offsetClosed(normalize([bowtie], 'nonzero'), 1);

		expect(direct.length).toBeGreaterThan(cleaned.length);
		expect(cleaned).toHaveLength(1);
	});
});


describe('offsetSeries — the API that makes chained-offset drift impossible', () => {

	it('measures every pass from the original, not from the previous pass', () => {
		const source = [rect(0, 0, 100, 100)];
		const step = 0.6349271;
		const passes = 40;

		const deltas = Array.from({ length: passes }, (_, i) => -(i + 1) * step);
		const series = offsetSeries(source, deltas);

		// chain the same passes the naive way
		let chained = source;
		for (let i = 0; i < passes; i++)
			chained = offsetClosed(chained, -step);

		const expected = passes * step;
		const seriesError = Math.abs(boundsOf(series[passes - 1]).minX - expected);
		const chainedError = Math.abs(boundsOf(chained).minX - expected);

		// computing from the original stays essentially exact
		expect(seriesError).toBeLessThan(1e-4);

		// while chaining accumulates rounding at every step
		expect(chainedError).toBeGreaterThan(seriesError);
	});

	it('returns one polygon set per requested delta', () => {
		const result = offsetSeries([rect(0, 0, 20, 20)], [-1, -3, -5]);
		expect(result).toHaveLength(3);
		expect(totalArea(result[0])).toBeGreaterThan(totalArea(result[2]));
	});

	it('yields an empty set once the shape has been consumed', () => {
		const result = offsetSeries([rect(0, 0, 10, 10)], [-1, -4, -9]);
		expect(result[2]).toEqual([]);
	});
});


describe('winding', () => {

	it('reports counter-clockwise as positive area in our y-up space', () => {
		expect(signedArea(rect(0, 0, 10, 10))).toBeCloseTo(100, 9);
		expect(isClockwise(rect(0, 0, 10, 10))).toBe(false);
	});

	it('reports clockwise as negative', () => {
		expect(signedArea(reverse(rect(0, 0, 10, 10)))).toBeCloseTo(-100, 9);
		expect(isClockwise(reverse(rect(0, 0, 10, 10)))).toBe(true);
	});

	it('treats a degenerate polygon as zero area', () => {
		expect(signedArea([[0, 0], [1, 1]])).toBe(0);
		expect(signedArea([])).toBe(0);
	});

	it('does not mutate its input when reversing', () => {
		const original = rect(0, 0, 10, 10);
		const copy = [...original];
		reverse(original);
		expect(original).toEqual(copy);
	});
});
