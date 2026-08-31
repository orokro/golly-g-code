import { describe, it, expect } from 'vitest';
import { arcLengths, pointAt, projectOnto, placeTabs, planPass, tabBreaks, measureBridges } from './tabs.js';
import { offsetAlongNormals, openToolpath, OpenMode, Side } from './openOffset.js';
import { computeDepthPasses } from './depth.js';

/** A gentle arc, so inside and outside toolpaths have genuinely different lengths. */
const arc = (radius, sweep = Math.PI / 2, steps = 400) => {
	const pts = [];
	for (let i = 0; i <= steps; i++) {
		const a = (i / steps) * sweep;
		pts.push([radius * Math.cos(a), radius * Math.sin(a)]);
	}
	return pts;
};

const lengthOf = (path) => arcLengths(path)[path.length - 1];

/**
 * A tab position in millimetres, written as the fraction of the source it used
 * to be. Positions are real arc lengths now (see tabs.js); the tests still read
 * better as "halfway along" than as "37.9mm along".
 */
const along = (source, fraction) => lengthOf(source) * fraction;

/** Where a toolpath span sits back on the source, in source arc length. */
const backOntoSource = (source, toolpath, span) => {
	const toolLengths = arcLengths(toolpath);
	const sourceLengths = arcLengths(source);
	const at = (d) => projectOnto(source, pointAt(toolpath, d, toolLengths), sourceLengths).distance;
	return { start: at(span.start), end: at(span.end) };
};


describe('arc length helpers', () => {

	it('measures cumulative length', () => {
		expect(arcLengths([[0, 0], [3, 0], [3, 4]])).toEqual([0, 3, 7]);
	});

	it('finds a point partway along, across a segment boundary', () => {
		const [x, y] = pointAt([[0, 0], [10, 0], [10, 10]], 15);
		expect(x).toBeCloseTo(10, 9);
		expect(y).toBeCloseTo(5, 9);
	});

	it('clamps to the ends rather than extrapolating', () => {
		expect(pointAt([[0, 0], [10, 0]], -5)).toEqual([0, 0]);
		expect(pointAt([[0, 0], [10, 0]], 999)).toEqual([10, 0]);
	});

	it('projects a point onto the nearest place on the path', () => {
		const found = projectOnto([[0, 0], [10, 0]], [4, 3]);
		expect(found.distance).toBeCloseTo(4, 9);
		expect(found.offset).toBeCloseTo(3, 9);
	});
});


describe('a tab is a width of material, not a length of toolpath', () => {

	const TOLERANCE = 0.005;

	it('is exactly the asked-for width on a straight line', () => {
		const source = [[0, 0], [100, 0]];
		const { path } = offsetAlongNormals(source, 3, { side: Side.LEFT, tolerance: TOLERANCE });
		const { spans } = placeTabs(source, path, [{ position: along(source, 0.5), length: 8 }]);

		expect(spans).toHaveLength(1);
		expect(spans[0].end - spans[0].start).toBeCloseTo(8, 6);
		expect((spans[0].start + spans[0].end) / 2).toBeCloseTo(50, 6);
	});

	it('STAYS PUT when the tool diameter changes — the jscut complaint', () => {
		// jscut anchors a tab to the toolpath, so changing the cutter moves every
		// tab and resizes it. Anchored to the source, neither happens.
		const source = arc(40);
		const footprints = [];

		for (const radius of [0.5, 1.5875, 3, 6]) {
			const { path } = offsetAlongNormals(source, radius, { side: Side.LEFT, tolerance: TOLERANCE });
			const { spans } = placeTabs(source, path, [{ position: along(source, 0.5), length: 8 }]);
			expect(spans, `${radius}mm`).toHaveLength(1);
			footprints.push(backOntoSource(source, path, spans[0]));
		}

		// every cutter leaves the bridge in the same place, the same width
		for (const shape of footprints) {
			expect(shape.start).toBeCloseTo(footprints[0].start, 1);
			expect(shape.end).toBeCloseTo(footprints[0].end, 1);
			expect(shape.end - shape.start).toBeCloseTo(8, 1);
		}
	});

	it('travels further than 8mm round the outside and less round the inside', () => {
		// the same 8mm bridge, from both sides. This difference is the reason the
		// tab is anchored to the source: it is real, and anchoring to the
		// toolpath would bake it into the part instead.
		const source = arc(40);
		const outside = offsetAlongNormals(source, 6, { side: Side.RIGHT, tolerance: TOLERANCE }).path;
		const inside = offsetAlongNormals(source, 6, { side: Side.LEFT, tolerance: TOLERANCE }).path;

		const tab = [{ position: along(source, 0.5), length: 8 }];
		const out = placeTabs(source, outside, tab).spans[0];
		const inn = placeTabs(source, inside, tab).spans[0];

		expect(lengthOf(outside)).toBeGreaterThan(lengthOf(inside));
		expect(out.end - out.start).toBeGreaterThan(8);
		expect(inn.end - inn.start).toBeLessThan(8);

		// and both are still the same 8mm of material
		expect(backOntoSource(source, outside, out).end - backOntoSource(source, outside, out).start)
			.toBeCloseTo(8, 1);
		expect(backOntoSource(source, inside, inn).end - backOntoSource(source, inside, inn).start)
			.toBeCloseTo(8, 1);
	});

	it('merges tabs that overlap, rather than wobbling Z inside one bridge', () => {
		const source = [[0, 0], [100, 0]];
		const { spans, warnings } = placeTabs(source, source, [
			{ position: along(source, 0.5), length: 10 },
			{ position: along(source, 0.52), length: 10 },
		]);
		expect(spans).toHaveLength(1);
		expect(spans[0].start).toBeCloseTo(45, 6);
		expect(spans[0].end).toBeCloseTo(57, 6);
		expect(warnings.join(' ')).toMatch(/merged/);
	});

	it('refuses a tab longer than the path instead of leaving the part uncut', () => {
		const source = [[0, 0], [20, 0]];
		const { spans, warnings } = placeTabs(source, source, [{ position: along(source, 0.5), length: 50 }]);
		expect(spans).toHaveLength(0);
		expect(warnings.join(' ')).toMatch(/does not fit/);
	});

	it('is measured in millimetres, not as a fraction', () => {

		// The distinguishing case: 0.5 used to mean the middle of anything. It now
		// means half a millimetre from the start, and on a 20mm path the middle is
		// at 10. A fraction-based implementation puts this tab at 10 and passes
		// every other test in this file.
		const source = [[0, 0], [20, 0]];
		const { spans } = placeTabs(source, source, [{ position: 0.5, length: 2 }]);
		expect(spans[0].start).toBeCloseTo(0, 6);
		expect(spans[0].end).toBeCloseTo(1.5, 6);
	});

	it('moves a tab past the end back onto the path, and says so', () => {
		const source = [[0, 0], [20, 0]];
		const { spans, warnings } = placeTabs(source, source, [{ position: 400, length: 4 }]);
		expect(spans[0].end).toBeCloseTo(20, 6);
		expect(warnings.join(' ')).toMatch(/moved to the end/);
	});

	it('rejects a malformed tab', () => {
		const source = [[0, 0], [20, 0]];
		expect(() => placeTabs(source, source, [{ position: -1, length: 2 }])).toThrow(RangeError);
		expect(() => placeTabs(source, source, [{ position: along(source, 0.5), length: 0 }])).toThrow(RangeError);
	});
});


describe('what the bridge actually measures', () => {

	const TOLERANCE = 0.005;

	it('leaves exactly the asked-for length standing at the part edge', () => {
		// Ground truth, not span arithmetic. At full depth the cutter touches the
		// line at one point and never crosses it, so the material left at the
		// part edge is exactly the lifted span — for ANY cutter size.
		const source = [[0, 0], [200, 0]];

		for (const radius of [0.5, 1.5875, 3]) {
			const { path } = offsetAlongNormals(source, radius, { side: Side.LEFT, tolerance: TOLERANCE });
			const { spans } = placeTabs(source, path, [{ position: along(source, 0.5), length: 8 }]);
			expect(spans[0].end - spans[0].start, `${radius}mm`).toBeCloseTo(8, 6);

			// and the standing material, measured against the full-depth toolpath
			const toolLengths = arcLengths(path);
			const cuts = (x) => {
				// nearest full-depth toolpath point to this point on the line
				let near = Infinity;
				for (let s = 0; s <= toolLengths[path.length - 1]; s += 0.05) {
					if (s > spans[0].start && s < spans[0].end)
						continue;
					const q = pointAt(path, s, toolLengths);
					near = Math.min(near, Math.hypot(q[0] - x, q[1] - 0));
				}
				return near <= radius + 1e-6;
			};
			expect(cuts(spans[0].start - 1), `cut before the tab, ${radius}mm`).toBe(true);
			expect(cuts(spans[0].end + 1), `cut after the tab, ${radius}mm`).toBe(true);
			expect(cuts((spans[0].start + spans[0].end) / 2), `standing mid-tab, ${radius}mm`).toBe(false);
		}
	});

	it('says so when a tab is too narrow for the cutter to leave anything', () => {
		const source = [[0, 0], [100, 0]];
		const { warnings } = placeTabs(source, source, [{ position: along(source, 0.5), length: 3 }],
			{ toolRadius: 1.5875 });
		expect(warnings.join(' ')).toMatch(/tapers to nothing/);
	});

	it('stays quiet for a tab comfortably wider than the cutter', () => {
		const source = [[0, 0], [100, 0]];
		const { warnings } = placeTabs(source, source, [{ position: along(source, 0.5), length: 8 }],
			{ toolRadius: 1.5875 });
		expect(warnings).toEqual([]);
	});
});


describe("a tab is a break in the cut — Greg's worked example", () => {

	// 4mm stock, cut 5mm to go through into the spoilboard, 1mm passes, so five
	// passes. A tab set to 3mm leaves 1mm of material standing under it. The
	// first three passes cut straight through the tab; the last two break.
	const THICKNESS = 4;
	const CUT_DEPTH = 5;
	const PASS = 1;
	const passes = computeDepthPasses(CUT_DEPTH, PASS);

	const toolpath = [[0, 0], [100, 0]];
	const spans = [{ start: 46, end: 54, depth: 3 }];

	it('cuts five passes to get through 4mm of stock into the spoilboard', () => {
		expect(passes).toEqual([-1, -2, -3, -4, -5]);
	});

	it('runs the first three passes straight through the tab', () => {
		for (const passZ of [-1, -2, -3]) {
			const runs = planPass(toolpath, spans, passZ);
			expect(runs, `${passZ}`).toHaveLength(1);
			expect(runs[0].points).toEqual(toolpath);
		}
	});

	it('breaks the last two passes into two runs with a gap over the tab', () => {
		for (const passZ of [-4, -5]) {
			const runs = planPass(toolpath, spans, passZ);
			expect(runs, `${passZ}`).toHaveLength(2);
			expect(runs[0].end).toBeCloseTo(46, 9);
			expect(runs[1].start).toBeCloseTo(54, 9);
			// and the gap really is left uncut
			expect(runs[0].points[runs[0].points.length - 1][0]).toBeCloseTo(46, 9);
			expect(runs[1].points[0][0]).toBeCloseTo(54, 9);
		}
	});

	it('leaves exactly thickness minus tab depth standing', () => {
		const deepest = passes.filter((z) => !tabBreaks(z, 3)).at(-1);
		expect(deepest).toBe(-3);
		expect(THICKNESS - 3).toBe(1);
	});

	it('never cuts a zero-depth tab at all', () => {
		for (const passZ of passes)
			expect(planPass(toolpath, [{ start: 46, end: 54, depth: 0 }], passZ), `${passZ}`)
				.toHaveLength(2);
	});

	it('never breaks for a tab deeper than the cut', () => {
		for (const passZ of passes)
			expect(planPass(toolpath, [{ start: 46, end: 54, depth: 9 }], passZ), `${passZ}`)
				.toHaveLength(1);
	});
});


describe('per-tab depth and length, with job defaults', () => {

	const source = [[0, 0], [200, 0]];

	it('falls back to the job default for anything a tab does not set', () => {
		const { spans } = placeTabs(source, source, [{ position: along(source, 0.5) }],
			{ defaultLength: 10, defaultDepth: 2 });
		expect(spans[0].end - spans[0].start).toBeCloseTo(10, 6);
		expect(spans[0].depth).toBe(2);
	});

	it('lets a tab override either one', () => {
		const { spans } = placeTabs(source, source,
			[{ position: along(source, 0.25), length: 4 }, { position: along(source, 0.75), depth: 3.5 }],
			{ defaultLength: 10, defaultDepth: 2 });
		expect(spans[0].end - spans[0].start).toBeCloseTo(4, 6);
		expect(spans[0].depth).toBe(2);
		expect(spans[1].end - spans[1].start).toBeCloseTo(10, 6);
		expect(spans[1].depth).toBe(3.5);
	});

	it('gives merged tabs the shallower depth, so the most material survives', () => {
		const { spans } = placeTabs(source, source, [
			{ position: along(source, 0.5), length: 20, depth: 3 },
			{ position: along(source, 0.55), length: 20, depth: 1 },
		]);
		expect(spans).toHaveLength(1);
		expect(spans[0].depth).toBe(1);
	});

	it('rejects a negative depth', () => {
		expect(() => placeTabs(source, source, [{ position: along(source, 0.5), depth: -1 }])).toThrow(RangeError);
	});

	it('makes tabs of different depths break on different passes', () => {
		const { spans } = placeTabs(source, source,
			[{ position: along(source, 0.25), depth: 1 }, { position: along(source, 0.75), depth: 3 }]);

		expect(planPass(source, spans, -2)).toHaveLength(2);
		expect(planPass(source, spans, -4)).toHaveLength(3);
	});
});


describe('measuring what is actually left holding the part', () => {

	const TOLERANCE = 0.005;
	const R = 1.5875;

	it('finds a bridge exactly where the tab is, the size the tab is', () => {
		const source = [[0, 0], [200, 0]];
		const { path } = offsetAlongNormals(source, R, { side: Side.LEFT, tolerance: TOLERANCE });
		const { spans } = placeTabs(source, path, [{ position: along(source, 0.5), length: 8, depth: 3 }]);
		const runs = planPass(path, spans, -4);

		const bridges = measureBridges(source, runs, R);
		expect(bridges).toHaveLength(1);
		expect(bridges[0].length).toBeCloseTo(8, 0);
		expect((bridges[0].start + bridges[0].end) / 2).toBeCloseTo(100, 0);
	});

	it('finds nothing standing on a pass the tab does not break', () => {
		const source = [[0, 0], [200, 0]];
		const { path } = offsetAlongNormals(source, R, { side: Side.LEFT, tolerance: TOLERANCE });
		const { spans } = placeTabs(source, path, [{ position: along(source, 0.5), length: 8, depth: 3 }]);
		expect(measureBridges(source, planPass(path, spans, -2), R)).toEqual([]);
	});

	it('reports detail finer than the cutter as the bridge it is', () => {
		// a notch 1mm wide against a 3.175mm cutter: the tool cannot get in, so
		// that material stands whether or not anybody asked for a tab there
		const source = [[0, 0], [40, 0], [40, 10], [41, 10], [41, 0], [80, 0]];
		const { path } = offsetAlongNormals(source, R, { side: Side.LEFT, tolerance: TOLERANCE });
		const runs = planPass(path, [], -4);

		const bridges = measureBridges(source, runs, R);
		expect(bridges.length).toBeGreaterThan(0);
		expect(Math.max(...bridges.map((b) => b.length))).toBeGreaterThan(2);
	});

	it('rejects a non-positive tool radius', () => {
		expect(() => measureBridges([[0, 0], [1, 0]], [], 0)).toThrow(RangeError);
	});
});


describe('a hand-placed tab survives changing the job around it', () => {

	// Greg places tabs by hand on the Job and expects them to "just work". The
	// two things that move underneath them are the cutter and the offset MODE,
	// and changing the mode replaces the toolpath entirely rather than nudging
	// it. Anchoring to the source is supposed to make both harmless; that is
	// worth checking rather than believing.

	const TOLERANCE = 0.005;
	const source = [[0, 0], [60, 0], [60, 40], [120, 40], [120, 0], [180, 0]];
	const hand = [{ position: along(source, 0.2), length: 8, depth: 3 }, { position: along(source, 0.7), length: 8, depth: 3 }];

	/**
	 * How far the middle of a toolpath span is from where the tab was placed.
	 *
	 * No inverse mapping, deliberately. Nearest-point projection has now failed
	 * as an inverse three separate times in this file — around a corner, and
	 * again where a heading offset lays the shifted path directly on top of the
	 * original. What is true in every mode without needing an inverse is that
	 * the tab's middle should sit exactly the offset distance from the point on
	 * the drawing where it was placed. A tab that slid along the path fails
	 * that: it would be nearer, or further, than the offset.
	 */
	const missBy = (toolpath, span, position) => {
		const sourceLengths = arcLengths(source);
		const placed = pointAt(source, position, sourceLengths);
		const toolLengths = arcLengths(toolpath);
		const middle = pointAt(toolpath, (span.start + span.end) / 2, toolLengths);
		return Math.hypot(middle[0] - placed[0], middle[1] - placed[1]);
	};

	it('stays put when the offset mode changes, not just the cutter', () => {
		const radius = 1.5875;
		const variants = [
			['centre', 0, { mode: OpenMode.CENTER }],
			['normal A', radius,
				{ mode: OpenMode.NORMAL, distance: radius, side: Side.LEFT, tolerance: TOLERANCE }],
			['normal B', radius,
				{ mode: OpenMode.NORMAL, distance: radius, side: Side.RIGHT, tolerance: TOLERANCE }],
			['heading', 6, { mode: OpenMode.HEADING, distance: 6, angleRadians: Math.PI / 2 }],
		];

		for (const [label, offset, options] of variants) {

			const { path, congruent } = openToolpath(source, options);
			const { spans } = placeTabs(source, path, hand, { toolRadius: radius, congruent });

			expect(spans, label).toHaveLength(2);

			spans.forEach((span, i) => {
				// exactly the offset away from where it was placed, and no
				// further along the path than that
				expect(missBy(path, span, hand[i].position), `${label} tab ${i}`)
					.toBeCloseTo(offset, 1);
				expect(span.end - span.start, `${label} tab ${i} width`).toBeCloseTo(8, 1);
			});
		}
	});

	it('maps a heading offset straight across, not around the nearest corner', () => {
		// The bug this file found. A 6mm heading offset moves the whole path
		// rigidly, so a tab at source 178..186 belongs at toolpath 178..186.
		// Nearest-point projection put it at 184..192, because the nearest bit of
		// the shifted path to the tab was around a corner.
		const { path, congruent } = openToolpath(source,
			{ mode: OpenMode.HEADING, distance: 6, angleRadians: Math.PI / 2 });
		const { spans } = placeTabs(source, path, [{ position: along(source, 0.7), length: 8, depth: 3 }],
			{ congruent });

		expect(spans[0].start).toBeCloseTo(178, 6);
		expect(spans[0].end).toBeCloseTo(186, 6);
	});

	it('breaks the same passes whatever the mode, since depth is the source of that', () => {
		const radius = 1.5875;
		for (const options of [
			{ mode: OpenMode.CENTER },
			{ mode: OpenMode.NORMAL, distance: radius, tolerance: TOLERANCE },
		]) {
			const { path, congruent } = openToolpath(source, options);
			const { spans } = placeTabs(source, path, hand, { toolRadius: radius, congruent });
			expect(planPass(path, spans, -2)).toHaveLength(1);
			expect(planPass(path, spans, -4)).toHaveLength(3);
		}
	});
});
