import { describe, it, expect } from 'vitest';
import { offsetByHeading, offsetAlongNormals, resample, Side } from './openOffset.js';

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

/**
 * Closest the offset path ever comes to the source, sampled ALONG its segments.
 *
 * Sampling only the vertices is what let a broken implementation pass: a mitre
 * could overshoot past the far side of a feature, leaving both endpoints a
 * legitimate distance away while the segment between them cut straight through.
 * The tool follows the segments, so the test has to as well.
 */
const closestApproachOne = (offset, source, samplesPerSegment = 24) => {
	let best = Infinity;
	for (let i = 0; i + 1 < offset.length; i++) {
		const [ax, ay] = offset[i];
		const [bx, by] = offset[i + 1];
		for (let k = 0; k <= samplesPerSegment; k++) {
			const t = k / samplesPerSegment;
			best = Math.min(best, distanceToPath([ax + (t * (bx - ax)), ay + (t * (by - ay))], source));
		}
	}
	return best;
};

/** Worst approach across EVERY piece of a possibly-fragmented offset. */
const closestApproach = (paths, source, samplesPerSegment = 24) =>
	Math.min(...paths.map((p) => closestApproachOne(p, source, samplesPerSegment)));

/** Total length of every piece, for checking coverage. */
const totalLength = (paths) => paths.reduce((sum, p) => {
	let length = 0;
	for (let i = 0; i + 1 < p.length; i++)
		length += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
	return sum + length;
}, 0);

const wave = (amplitude, wavelength, width = 200, step = 0.25) => {
	const pts = [];
	for (let x = 0; x <= width; x += step)
		pts.push([x, amplitude * Math.sin((2 * Math.PI * x) / wavelength)]);
	return pts;
};

/** A coarse zigzag of roof peaks — the shape that broke the hand-rolled version. */
const rooftops = () => {
	const pts = [[0, 0]];
	for (let i = 0; i < 6; i++) {
		const x = i * 30;
		pts.push([x + 10, 22], [x + 22, 0], [x + 30, 0]);
	}
	return pts;
};


describe('heading offset', () => {

	it('moves every point by the same vector', () => {
		const moved = offsetByHeading([[0, 0], [10, 0], [10, 10]], 5, Math.PI / 2);
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


describe('normal offset', () => {

	it('offsets a straight line to a parallel line, in one piece', () => {
		const { paths } = offsetAlongNormals([[0, 0], [100, 0]], 3, { side: Side.LEFT });
		expect(paths).toHaveLength(1);
		for (const [, y] of paths[0])
			expect(y).toBeCloseTo(3, 2);
	});

	it('puts left and right on opposite sides', () => {
		const left = offsetAlongNormals([[0, 0], [100, 0]], 3, { side: Side.LEFT });
		const right = offsetAlongNormals([[0, 0], [100, 0]], 3, { side: Side.RIGHT });
		expect(left.paths[0][0][1]).toBeGreaterThan(0);
		expect(right.paths[0][0][1]).toBeLessThan(0);
	});

	it('returns the full swept outline as well as the one side', () => {
		const { paths, outline } = offsetAlongNormals([[0, 0], [100, 0]], 3);
		expect(outline.length).toBeGreaterThan(paths[0].length);
	});
});


describe('the offset never cuts closer than it was asked to', () => {

	// Two sources of legitimate shortfall, and nothing else is acceptable:
	//   - polygonal arcs are INSCRIBED, so an offset falls inside the true one
	//     by at most the arc tolerance
	//   - Clipper works on an integer grid of 1e-4 mm, which rounds both the
	//     offset distance and the arc tolerance itself
	// Measured shortfall is 0.00503mm for a 0.005mm tolerance, so the grid
	// contributes about 3e-5. Allowing a micron over covers it without
	// weakening the assertion: the bug this test exists for measured 1.5875mm.
	const TOLERANCE = 0.005;
	const slack = TOLERANCE + 0.001;

	it('holds the distance on a gentle curve', () => {
		const source = wave(6, 90);
		const { paths } = offsetAlongNormals(source, 1.5, { side: Side.LEFT, tolerance: TOLERANCE });
		expect(closestApproach(paths, source)).toBeGreaterThanOrEqual(1.5 - slack);
	});

	it('holds the distance where the curve is far tighter than the offset', () => {
		// radius of curvature well under 0.5mm against a 1.5mm offset
		const source = wave(9, 12, 120);
		const { paths } = offsetAlongNormals(source, 1.5, { side: Side.LEFT, tolerance: TOLERANCE });
		expect(paths.length).toBeGreaterThan(0);
		expect(closestApproach(paths, source)).toBeGreaterThanOrEqual(1.5 - slack);
	});

	it('holds the distance on a COARSE zigzag — the case that broke the last version', () => {
		// long segments and sharp valleys. A hand-rolled mitre overshot past the
		// far side of a peak here: both its endpoints were a full offset distance
		// from the source while the segment between them passed through it,
		// measuring 0.0000mm against a requested 1.5875mm.
		const source = rooftops();
		const { paths } = offsetAlongNormals(source, 1.5875, { side: Side.LEFT, tolerance: TOLERANCE });

		expect(paths.length).toBeGreaterThan(0);
		expect(closestApproach(paths, source)).toBeGreaterThanOrEqual(1.5875 - slack);
	});

	it('holds the distance on both sides', () => {
		const source = rooftops();
		for (const side of [Side.LEFT, Side.RIGHT]) {
			const { paths } = offsetAlongNormals(source, 2, { side, tolerance: TOLERANCE });
			expect(closestApproach(paths, source), side).toBeGreaterThanOrEqual(2 - slack);
		}
	});

	it('holds the distance at several offsets', () => {
		const source = wave(9, 20, 120);
		for (const distance of [0.5, 1.5, 3, 6]) {
			const { paths } = offsetAlongNormals(source, distance, { tolerance: TOLERANCE });
			expect(closestApproach(paths, source), `${distance}mm`)
				.toBeGreaterThanOrEqual(distance - slack);
		}
	});
});


describe('degenerate input', () => {

	it('rejects a non-positive distance', () => {
		expect(() => offsetAlongNormals([[0, 0], [1, 0]], 0)).toThrow(RangeError);
		expect(() => offsetAlongNormals([[0, 0], [1, 0]], -2)).toThrow(RangeError);
	});

	it('returns nothing for a path with no length', () => {
		expect(offsetAlongNormals([], 1).paths).toEqual([]);
		expect(offsetAlongNormals([[5, 5]], 1).paths).toEqual([]);
		expect(offsetAlongNormals([[5, 5], [5, 5], [5, 5]], 1).paths).toEqual([]);
	});

	it('ignores repeated points, which have no direction', () => {
		const { paths } = offsetAlongNormals([[0, 0], [0, 0], [50, 0], [50, 0]], 2, { side: Side.LEFT });
		expect(paths).toHaveLength(1);
		for (const [, y] of paths[0])
			expect(y).toBeCloseTo(2, 2);
	});

	it('survives a complete reversal without producing infinities', () => {
		const { paths } = offsetAlongNormals([[0, 0], [50, 0], [0, 0.001]], 3, { side: Side.LEFT });
		expect(paths.flat().every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
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


describe('one side can be several pieces', () => {

	const TOLERANCE = 0.005;
	const slack = TOLERANCE + 0.001;

	it('keeps EVERY piece, not just the longest', () => {
		// Deep valleys narrower than twice the offset break one side into
		// disconnected runs. Keeping only the longest silently drops most of the
		// cut -- on a real skyline it lost a quarter of it.
		const source = rooftops();
		const { paths } = offsetAlongNormals(source, 1.5875, { side: Side.LEFT, tolerance: TOLERANCE });

		expect(paths.length).toBeGreaterThan(1);

		// and the pieces together cover far more than any single one
		const longest = Math.max(...paths.map((p) => p.length));
		expect(paths.flat().length).toBeGreaterThan(longest * 1.5);
	});

	it('handles a path that deliberately retraces itself', () => {
		// drawn to run back over ground it has already covered, which is a real
		// technique and makes "the left side" genuinely discontinuous
		const source = [[0, 0], [40, 0], [40, 25], [40, 0], [80, 0], [80, 25], [80, 0], [120, 0]];

		const { paths } = offsetAlongNormals(source, 2, { side: Side.LEFT, tolerance: TOLERANCE });

		expect(paths.length).toBeGreaterThan(0);
		expect(closestApproach(paths, source)).toBeGreaterThanOrEqual(2 - slack);

		// The left side here is the top edge in three stretches (38 + 36 + 38)
		// plus the near wall of each spur (25 each) and half of each spur's cap:
		// about 164mm, measured 164.34. A version that severed the run at each
		// spur base managed 89.77, and a version that kept only the longest run
		// managed 63.89 -- so anything at or below 160 is a real regression, not
		// a rounding difference.
		expect(totalLength(paths)).toBeGreaterThan(160);
	});

	it('does not let a spur sever the run it grows from', () => {
		// The corner where a spur meets its parent run sits EXACTLY equidistant
		// from both source segments, and the tie is broken arbitrarily. Judging
		// that one vertex instead of the edges either side of it tagged the
		// corner for the far side and cut the run in two there, silently losing
		// the whole stretch of top edge beyond it.
		const source = [[0, 0], [50, 0], [50, 20], [50, 0], [100, 0]];
		const { paths } = offsetAlongNormals(source, 2, { side: Side.LEFT, tolerance: TOLERANCE });

		expect(closestApproach(paths, source)).toBeGreaterThanOrEqual(2 - slack);

		// the top edge either side of the spur is the part that went missing, so
		// ask for it directly rather than trusting a total
		const covers = (x) => paths.some((piece) => distanceToPath([x, 2], piece) < 0.01);
		expect(covers(10), 'before the spur').toBe(true);
		expect(covers(90), 'after the spur').toBe(true);
	});

	it('discards runs too short to be a cut, by LENGTH not point count', () => {
		// A point count looks like the same rule and is not: the offset of a
		// straight line is a rectangle whose left side is a single edge between
		// two vertices, and 100mm of perfectly good cut.
		const straight = offsetAlongNormals([[0, 0], [100, 0]], 3, { tolerance: TOLERANCE });
		expect(straight.paths).toHaveLength(1);
		expect(straight.paths[0]).toHaveLength(2);
		expect(totalLength(straight.paths)).toBeCloseTo(100, 6);

		// nothing kept anywhere is shorter than the arc chord at that offset,
		// which is the resolution the outline is described at
		for (const distance of [0.5, 1.5875, 3]) {
			const chord = 2 * Math.sqrt((2 * distance * TOLERANCE) - (TOLERANCE * TOLERANCE));
			const { paths } = offsetAlongNormals(rooftops(), distance, { tolerance: TOLERANCE });
			for (const piece of paths)
				expect(totalLength([piece]), `${distance}mm`).toBeGreaterThan(chord);
		}
	});
});
