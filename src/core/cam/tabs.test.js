import { describe, it, expect } from 'vitest';
import { arcLengths, pointAt, projectOnto, placeTabs, splitAtTabs, tabZ } from './tabs.js';
import { offsetAlongNormals, Side } from './openOffset.js';

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
		const { spans } = placeTabs(source, path, [{ position: 0.5, length: 8 }]);

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
			const { spans } = placeTabs(source, path, [{ position: 0.5, length: 8 }]);
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

		const tab = [{ position: 0.5, length: 8 }];
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
			{ position: 0.5, length: 10 },
			{ position: 0.52, length: 10 },
		]);
		expect(spans).toHaveLength(1);
		expect(spans[0].start).toBeCloseTo(45, 6);
		expect(spans[0].end).toBeCloseTo(57, 6);
		expect(warnings.join(' ')).toMatch(/merged/);
	});

	it('refuses a tab longer than the path instead of leaving the part uncut', () => {
		const source = [[0, 0], [20, 0]];
		const { spans, warnings } = placeTabs(source, source, [{ position: 0.5, length: 50 }]);
		expect(spans).toHaveLength(0);
		expect(warnings.join(' ')).toMatch(/does not fit/);
	});

	it('rejects a malformed tab', () => {
		const source = [[0, 0], [20, 0]];
		expect(() => placeTabs(source, source, [{ position: 1.5, length: 2 }])).toThrow(RangeError);
		expect(() => placeTabs(source, source, [{ position: 0.5, length: 0 }])).toThrow(RangeError);
	});
});


describe('splitting a toolpath at its tabs', () => {

	it('alternates free and over-tab, covering the whole path exactly once', () => {
		const path = [[0, 0], [100, 0]];
		const runs = splitAtTabs(path, [{ start: 40, end: 50 }]);

		expect(runs.map((r) => r.overTab)).toEqual([false, true, false]);
		expect(runs.reduce((sum, r) => sum + lengthOf(r.points), 0)).toBeCloseTo(100, 9);

		// each run picks up where the last left off
		for (let i = 0; i + 1 < runs.length; i++)
			expect(runs[i].points[runs[i].points.length - 1]).toEqual(runs[i + 1].points[0]);
	});

	it('cuts exactly at the span boundary, not at the nearest vertex', () => {
		// the path's own vertices are 10mm apart; the tab is not
		const path = [[0, 0], [10, 0], [20, 0], [30, 0]];
		const runs = splitAtTabs(path, [{ start: 12.5, end: 17.5 }]);
		expect(runs[1].points[0][0]).toBeCloseTo(12.5, 9);
		expect(runs[1].points[runs[1].points.length - 1][0]).toBeCloseTo(17.5, 9);
	});

	it('keeps the original vertices inside each run, so the shape survives', () => {
		const path = [[0, 0], [10, 10], [20, 0], [30, 10], [40, 0]];
		const runs = splitAtTabs(path, [{ start: 5, end: 8 }]);
		const rebuilt = runs.flatMap((r) => r.points);
		for (const vertex of path)
			expect(rebuilt.some(([x, y]) => Math.hypot(x - vertex[0], y - vertex[1]) < 1e-9),
				`${vertex}`).toBe(true);
	});

	it('passes the path straight through when there are no tabs', () => {
		const path = [[0, 0], [10, 0]];
		expect(splitAtTabs(path, [])).toEqual([{ points: path, overTab: false }]);
	});
});


describe('how deep to go over a tab', () => {

	it('lifts to leave the tab standing once the pass is deeper than it', () => {
		// 18mm stock, 3mm tabs: the top of a tab is 15mm down
		const { z, engaged } = tabZ(-18, 3, 18);
		expect(engaged).toBe(true);
		expect(z).toBeCloseTo(-15, 9);
	});

	it('does not lift on passes shallower than the tab, which would just dent the wall', () => {
		const { z, engaged } = tabZ(-6, 3, 18);
		expect(engaged).toBe(false);
		expect(z).toBeCloseTo(-6, 9);
	});

	it('treats a pass landing exactly on the tab top as not yet engaged', () => {
		expect(tabZ(-15, 3, 18).engaged).toBe(false);
	});

	it('refuses a tab that does not fit in the material', () => {
		expect(() => tabZ(-18, 20, 18)).toThrow(RangeError);
		expect(() => tabZ(-18, 0, 18)).toThrow(RangeError);
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
			const { spans } = placeTabs(source, path, [{ position: 0.5, length: 8 }]);
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
		const { warnings } = placeTabs(source, source, [{ position: 0.5, length: 3 }],
			{ toolRadius: 1.5875 });
		expect(warnings.join(' ')).toMatch(/tapers to nothing/);
	});

	it('stays quiet for a tab comfortably wider than the cutter', () => {
		const source = [[0, 0], [100, 0]];
		const { warnings } = placeTabs(source, source, [{ position: 0.5, length: 8 }],
			{ toolRadius: 1.5875 });
		expect(warnings).toEqual([]);
	});
});
