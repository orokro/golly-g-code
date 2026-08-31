import { describe, it, expect } from 'vitest';
import {
	sliceBetween, tabBands, travelSegments, travelDistance, tabHandles, positionFromPoint,
} from './layers.js';

/** A 100mm straight line, so arc length and X are the same number. */
const LINE = [[0, 0], [100, 0]];

/** A 100mm line with vertices along it, so slicing has something to keep. */
const DOTTED = [[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]];


describe('slicing a polyline by arc length', () => {

	it('has exact ends, not the nearest vertex', () => {

		// The whole reason this is not a filter: a tab from 30 to 36 on a path
		// whose vertices are at 25 and 50 has no vertex inside it at all, and a
		// filter would return nothing where the answer is a 6mm band.
		expect(sliceBetween(DOTTED, 30, 36)).toEqual([[30, 0], [36, 0]]);
	});

	it('keeps the vertices in between', () => {
		expect(sliceBetween(DOTTED, 10, 60)).toEqual([[10, 0], [25, 0], [50, 0], [60, 0]]);
	});

	it('clamps to the path rather than extrapolating past its end', () => {
		expect(sliceBetween(LINE, 80, 400)).toEqual([[80, 0], [100, 0]]);
	});

	it('is empty for a zero-length or backwards span', () => {
		expect(sliceBetween(LINE, 40, 40)).toEqual([]);
		expect(sliceBetween(LINE, 60, 40)).toEqual([]);
	});

	it('is empty for a path too short to have a length', () => {
		expect(sliceBetween([[0, 0]], 0, 10)).toEqual([]);
	});
});


describe('the tab bands', () => {

	const entry = {
		jobId: 'j1', toolId: 't1',
		paths: [{ points: LINE }, { points: [[0, 10], [100, 10]] }],
		tabSpans: [[{ start: 20, end: 26, depth: 1 }], []],
	};

	it('draws a band per span, on the run the span belongs to', () => {
		const bands = tabBands([entry], () => 3.175);
		expect(bands).toHaveLength(1);
		expect(bands[0].points[0]).toEqual([20, 0]);
		expect(bands[0].width).toBe(3.175);
	});

	it('carries the depth, so a tab that is never cut can look different', () => {
		expect(tabBands([entry], () => 3)[0].depth).toBe(1);
	});

	it('leaves out a job that is not visible', () => {
		expect(tabBands([entry], () => 3, () => false)).toEqual([]);
	});

	it('does not fall over when a job has no spans at all', () => {
		expect(tabBands([{ jobId: 'j', paths: [{ points: LINE }] }], () => 3)).toEqual([]);
	});

	it('ignores a span whose run is not there', () => {
		// tabSpans is indexed by run; a mismatch is an off-by-one, not a crash
		const broken = { ...entry, paths: [{ points: LINE }] };
		expect(tabBands([broken], () => 3)).toHaveLength(1);
	});
});


describe('the travel layer', () => {

	const move = (jobId, z, from, to) => ({ jobId, z, from, to });

	it('collapses the same crossing repeated once per pass', () => {

		// A six-pass job crosses the same two tabs six times. Drawing twenty-four
		// lines on top of each other reads as four and costs six times as much.
		const travel = [
			move('j', -1, [0, 0], [10, 0]),
			move('j', -2, [0, 0], [10, 0]),
			move('j', -3, [0, 0], [10, 0]),
		];
		const segments = travelSegments(travel);

		expect(segments).toHaveLength(1);
		expect(segments[0].times).toBe(3);
	});

	it('keeps crossings that differ only in direction', () => {
		const segments = travelSegments([
			move('j', -1, [0, 0], [10, 0]),
			move('j', -1, [10, 0], [0, 0]),
		]);
		expect(segments).toHaveLength(2);
	});

	it('keeps the same crossing made by two different jobs apart', () => {
		const segments = travelSegments([
			move('a', -1, [0, 0], [10, 0]),
			move('b', -1, [0, 0], [10, 0]),
		]);
		expect(segments).toHaveLength(2);
	});

	it('leaves out a job that is not visible', () => {
		const travel = [move('a', -1, [0, 0], [10, 0]), move('b', -1, [0, 0], [20, 0])];
		expect(travelSegments(travel, (id) => id === 'a')).toHaveLength(1);
	});
});


describe('how far the tool travels without cutting', () => {

	it('counts every pass, not the distinct crossings', () => {

		// The number that changes when you reorder the jobs. Counting the deduped
		// lines instead would say a six-pass job costs the same as a one-pass one,
		// which is the opposite of the point.
		const travel = [
			{ from: [0, 0], to: [3, 4] },
			{ from: [0, 0], to: [3, 4] },
		];
		expect(travelDistance(travel)).toBeCloseTo(10, 9);
	});

	it('is zero for nothing at all', () => {
		expect(travelDistance([])).toBe(0);
		expect(travelDistance(undefined)).toBe(0);
	});
});


describe('the tab handles', () => {

	const entry = {
		jobId: 'j', tabAnchors: [
			{ tabId: 'a', position: 20, point: [20, 0] },
			{ tabId: 'b', position: 60, point: [60, 0] },
		],
	};

	it('gives one handle per tab node, carrying its job', () => {
		const handles = tabHandles([entry]);
		expect(handles.map((h) => h.tabId)).toEqual(['a', 'b']);
		expect(handles[0].jobId).toBe('j');
	});

	it('still gives two handles when the two tabs have merged into one bridge', () => {

		// The reason a handle is on the anchor and not on the band: two tabs
		// sharing material are ONE span, and a merged span cannot say which tab it
		// came from. Grab the band and you cannot know what you picked up.
		const merged = { ...entry, tabSpans: [[{ start: 18, end: 62, depth: 1 }]] };
		expect(tabHandles([merged])).toHaveLength(2);
	});

	it('leaves out a job that is not visible', () => {
		expect(tabHandles([entry], () => false)).toEqual([]);
	});
});


describe('dragging a tab back onto the source', () => {

	const square = { points: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]] };

	it('is the arc length of the nearest point on the path', () => {
		expect(positionFromPoint([square], [4, 0])).toBeCloseTo(4, 9);
		expect(positionFromPoint([square], [10, 6])).toBeCloseTo(16, 9);
	});

	it('projects a pointer that is off the line, rather than refusing it', () => {
		// the pointer is never exactly on a 0.1mm-wide path
		expect(positionFromPoint([square], [4, 2.5])).toBeCloseTo(4, 9);
	});

	it('lays several runs end to end, the way tab placement reads them', () => {

		// A job cutting two shapes has one arc-length space across both, so a tab
		// can be dragged from one outline onto the other without being deleted and
		// remade. 40 is the whole square, so 3 into the second run is 43.
		const other = { points: [[100, 0], [110, 0]] };
		expect(positionFromPoint([square, other], [103, 0])).toBeCloseTo(43, 9);
	});

	it('picks the nearer run when they overlap in X', () => {
		const low = { points: [[0, 0], [10, 0]] };
		const high = { points: [[0, 50], [10, 50]] };
		expect(positionFromPoint([low, high], [4, 49])).toBeCloseTo(14, 9);
	});

	it('is null when there is nothing to anchor to', () => {
		expect(positionFromPoint([], [0, 0])).toBe(null);
		expect(positionFromPoint([{ points: [[1, 1]] }], [0, 0])).toBe(null);
	});
});
