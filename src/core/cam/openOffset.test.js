import { describe, it, expect } from 'vitest';
import { offsetByHeading, offsetAlongNormals, openToolpath, resample, OpenMode, Side } from './openOffset.js';

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

/** Length of a polyline, for checking coverage. */
const lengthOf = (path) => {
	let length = 0;
	for (let i = 0; i + 1 < path.length; i++)
		length += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
	return length;
};

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
		const source = [[0, 0], [10, 0], [10, 10]];
		const moved = offsetByHeading(source, 5, 0);
		expect(moved).toEqual([[5, 0], [15, 0], [15, 10]]);
	});

	it('preserves the shape exactly, so it can never fold', () => {
		const source = wave(9, 12, 60);
		const moved = offsetByHeading(source, 3, Math.PI / 3);
		for (let i = 0; i + 1 < source.length; i++) {
			const before = Math.hypot(source[i + 1][0] - source[i][0], source[i + 1][1] - source[i][1]);
			const after = Math.hypot(moved[i + 1][0] - moved[i][0], moved[i + 1][1] - moved[i][1]);
			expect(after).toBeCloseTo(before, 9);
		}
	});
});


describe('normal offset', () => {

	const TOLERANCE = 0.005;

	it('offsets a straight line to a parallel line', () => {
		const { path } = offsetAlongNormals([[0, 0], [100, 0]], 3, { side: Side.LEFT, tolerance: TOLERANCE });
		for (const [, y] of path)
			expect(y).toBeCloseTo(3, 2);
	});

	it('puts left and right on opposite sides', () => {
		const left = offsetAlongNormals([[0, 0], [100, 0]], 3, { side: Side.LEFT, tolerance: TOLERANCE });
		const right = offsetAlongNormals([[0, 0], [100, 0]], 3, { side: Side.RIGHT, tolerance: TOLERANCE });
		expect(left.path[0][1]).toBeGreaterThan(0);
		expect(right.path[0][1]).toBeLessThan(0);
	});

	it('returns the full swept outline as well as the one side', () => {
		const { path, outline } = offsetAlongNormals([[0, 0], [100, 0]], 3);
		expect(outline.length).toBeGreaterThan(path.length);
	});

	it('starts and finishes square off the ends of the path', () => {
		// the cut begins one offset out along the normal at the start, not
		// somewhere round the end cap
		const { path } = offsetAlongNormals([[0, 0], [100, 0]], 3, { side: Side.LEFT, tolerance: TOLERANCE });
		expect(path[0][0]).toBeCloseTo(0, 2);
		expect(path[0][1]).toBeCloseTo(3, 2);
		expect(path[path.length - 1][0]).toBeCloseTo(100, 2);
		expect(path[path.length - 1][1]).toBeCloseTo(3, 2);
	});

	it('runs in the same direction as the source', () => {
		const { path } = offsetAlongNormals([[0, 0], [100, 0]], 3, { side: Side.LEFT, tolerance: TOLERANCE });
		expect(path[path.length - 1][0]).toBeGreaterThan(path[0][0]);
	});
});


describe('one side is ONE cut, start to finish', () => {

	// The thing an earlier version got wrong, and the reason it mattered: it
	// asked of every outline point "which side of the nearest source segment
	// are you on?" That has no good answer where a path doubles back (the two
	// sides swap in space) or where the offset merges over a narrow valley
	// (the outline belongs to neither side). It cut the path into pieces at
	// exactly the places a person would expect it to keep going.

	const TOLERANCE = 0.005;
	const slack = TOLERANCE + 0.001;

	/** Every piece of a path, split wherever it jumps further than a step could. */
	const pieces = (path, biggestStep) => {
		let count = path.length > 0 ? 1 : 0;
		for (let i = 0; i + 1 < path.length; i++)
			if (Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]) > biggestStep)
				count++;
		return count;
	};

	it('is one continuous run on a coarse zigzag with valleys tighter than the tool', () => {
		const source = rooftops();
		const { path } = offsetAlongNormals(source, 1.5875, { side: Side.LEFT, tolerance: TOLERANCE });
		expect(path.length).toBeGreaterThan(2);
		expect(closestApproachOne(path, source)).toBeGreaterThanOrEqual(1.5875 - slack);
		// no jump longer than the longest source segment: the walk never leaps
		expect(pieces(path, 40)).toBe(1);
	});

	it('follows a path that doubles back, round the tip and on', () => {
		// Greg's houses: drawn deliberately to run back over ground already cut.
		// The tool should wrap the tip of each spur and carry on, not stop.
		const source = [[0, 0], [40, 0], [40, 25], [40, 0], [80, 0], [80, 25], [80, 0], [120, 0]];
		const { path } = offsetAlongNormals(source, 2, { side: Side.LEFT, tolerance: TOLERANCE });

		expect(closestApproachOne(path, source)).toBeGreaterThanOrEqual(2 - slack);
		expect(pieces(path, 40)).toBe(1);

		// it goes up and over both spurs, so it is far longer than the 120mm
		// base alone -- a version that stopped at each reversal managed 89.77
		expect(lengthOf(path)).toBeGreaterThan(200);
	});

	it('covers nearly all of a long path rather than a fragment of it', () => {
		const source = wave(6, 90, 200);
		const { path } = offsetAlongNormals(source, 1.5, { side: Side.LEFT, tolerance: TOLERANCE });
		expect(lengthOf(path)).toBeGreaterThan(lengthOf(source) * 0.9);
	});
});


describe('the offset never cuts closer than it was asked to', () => {

	// Two sources of legitimate shortfall, and nothing else is acceptable:
	//   - polygonal arcs are INSCRIBED, so an offset falls inside the true one
	//     by at most the arc tolerance
	//   - Clipper works on an integer grid of 1e-4 mm
	// Measured shortfall is 0.00503mm for a 0.005mm tolerance. The bug this
	// test exists for measured 1.5875mm.
	const TOLERANCE = 0.005;
	const slack = TOLERANCE + 0.001;

	it('holds the distance on a gentle curve', () => {
		const source = wave(6, 90);
		const { path } = offsetAlongNormals(source, 1.5, { side: Side.LEFT, tolerance: TOLERANCE });
		expect(closestApproachOne(path, source)).toBeGreaterThanOrEqual(1.5 - slack);
	});

	it('holds the distance where the curve is far tighter than the offset', () => {
		const source = wave(9, 12, 120);
		const { path } = offsetAlongNormals(source, 1.5, { side: Side.LEFT, tolerance: TOLERANCE });
		expect(path.length).toBeGreaterThan(0);
		expect(closestApproachOne(path, source)).toBeGreaterThanOrEqual(1.5 - slack);
	});

	it('holds the distance on a COARSE zigzag — the case that broke the first version', () => {
		const source = rooftops();
		const { path } = offsetAlongNormals(source, 1.5875, { side: Side.LEFT, tolerance: TOLERANCE });
		expect(path.length).toBeGreaterThan(0);
		expect(closestApproachOne(path, source)).toBeGreaterThanOrEqual(1.5875 - slack);
	});

	it('holds the distance on both sides', () => {
		const source = rooftops();
		for (const side of [Side.LEFT, Side.RIGHT]) {
			const { path } = offsetAlongNormals(source, 2, { side, tolerance: TOLERANCE });
			expect(closestApproachOne(path, source), side).toBeGreaterThanOrEqual(2 - slack);
		}
	});

	it('holds the distance at several offsets', () => {
		const source = wave(9, 20, 120);
		for (const distance of [0.5, 1.5, 3, 6]) {
			const { path } = offsetAlongNormals(source, distance, { tolerance: TOLERANCE });
			expect(closestApproachOne(path, source), `${distance}mm`)
				.toBeGreaterThanOrEqual(distance - slack);
		}
	});

	it('holds it even at an offset large enough to swallow the ends', () => {
		// Round ends make this structural: every point of the outline is a full
		// offset from the source, so no arc of it can cut in. With butt ends the
		// cap lay ACROSS the path and this case measured 4.4087mm against 5.994.
		const source = wave(9, 20, 120);
		const { path, warnings } = offsetAlongNormals(source, 6, { tolerance: TOLERANCE });
		expect(closestApproachOne(path, source)).toBeGreaterThanOrEqual(6 - slack);
		// and it says so rather than quietly starting somewhere else
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toMatch(/swallow/);
	});
});


describe('degenerate input', () => {

	const TOLERANCE = 0.005;

	it('rejects a non-positive distance', () => {
		expect(() => offsetAlongNormals([[0, 0], [1, 0]], 0)).toThrow(RangeError);
		expect(() => offsetAlongNormals([[0, 0], [1, 0]], -1)).toThrow(RangeError);
	});

	it('returns nothing for a path with no length', () => {
		expect(offsetAlongNormals([[5, 5]], 2).path).toEqual([]);
		expect(offsetAlongNormals([], 2).path).toEqual([]);
	});

	it('ignores repeated points, which have no direction', () => {
		const { path } = offsetAlongNormals([[0, 0], [0, 0], [50, 0], [50, 0]], 2,
			{ side: Side.LEFT, tolerance: TOLERANCE });
		for (const [, y] of path)
			expect(y).toBeCloseTo(2, 2);
	});

	it('survives a complete reversal without producing infinities', () => {
		const { path } = offsetAlongNormals([[0, 0], [10, 0], [0, 0]], 1.5, { tolerance: TOLERANCE });
		for (const [x, y] of path) {
			expect(Number.isFinite(x)).toBe(true);
			expect(Number.isFinite(y)).toBe(true);
		}
	});
});


describe('resample', () => {

	it('spaces points evenly and keeps both ends', () => {
		const out = resample([[0, 0], [10, 0]], 2.5);
		expect(out[0]).toEqual([0, 0]);
		expect(out[out.length - 1]).toEqual([10, 0]);
		for (let i = 0; i + 1 < out.length; i++)
			expect(Math.hypot(out[i + 1][0] - out[i][0], out[i + 1][1] - out[i][1]))
				.toBeLessThanOrEqual(2.5 + 1e-9);
	});

	it('carries spacing across segment boundaries rather than restarting', () => {
		const out = resample([[0, 0], [3, 0], [6, 0]], 2);
		expect(out.map(([x]) => x)).toEqual([0, 2, 4, 6]);
	});

	it('rejects a non-positive spacing', () => {
		expect(() => resample([[0, 0], [1, 0]], 0)).toThrow(RangeError);
	});

	it('passes through a path too short to resample', () => {
		expect(resample([[1, 1]], 2)).toEqual([[1, 1]]);
	});
});


describe('the three things an open path can do', () => {

	const TOLERANCE = 0.005;
	const line = [[0, 0], [100, 0], [100, 50]];

	it('centre follows the drawing verbatim', () => {
		const { path } = openToolpath(line, { mode: OpenMode.CENTER });
		expect(path).toEqual(line);
	});

	it('centre ignores a distance rather than quietly offsetting', () => {
		expect(openToolpath(line, { mode: OpenMode.CENTER, distance: 5 }).path).toEqual(line);
	});

	it('heading moves the whole path rigidly', () => {
		const { path } = openToolpath(line, {
			mode: OpenMode.HEADING, distance: 4, angleRadians: Math.PI / 2,
		});
		// cos(pi/2) is 6.1e-17, not 0 (CONVENTIONS 6)
		expect(path).toHaveLength(3);
		path.forEach(([x, y], i) => {
			expect(x).toBeCloseTo(line[i][0], 9);
			expect(y).toBeCloseTo(line[i][1] + 4, 9);
		});
	});

	it('normal follows the shape, and puts the line on an EDGE of the cut', () => {
		// the distinction that matters: the tool centre sits one radius off, so
		// the drawn line is the boundary of the cut rather than its middle
		const radius = 1.5875;
		const { path } = openToolpath(line, {
			mode: OpenMode.NORMAL, distance: radius, side: Side.LEFT, tolerance: TOLERANCE,
		});
		expect(closestApproachOne(path, line)).toBeGreaterThanOrEqual(radius - TOLERANCE - 0.001);
	});

	it('centre keeps the tool centre ON the line, unlike either offset', () => {
		const radius = 1.5875;
		const centre = openToolpath(line, { mode: OpenMode.CENTER }).path;
		const normal = openToolpath(line, {
			mode: OpenMode.NORMAL, distance: radius, tolerance: TOLERANCE,
		}).path;

		expect(closestApproachOne(centre, line)).toBeCloseTo(0, 9);
		expect(closestApproachOne(normal, line)).toBeGreaterThan(radius / 2);
	});

	it('rejects an unknown mode rather than defaulting to one', () => {
		expect(() => openToolpath(line, { mode: 'sideways' })).toThrow(RangeError);
	});

	it('rejects a negative heading distance', () => {
		expect(() => openToolpath(line, { mode: OpenMode.HEADING, distance: -1 })).toThrow(RangeError);
	});
});
