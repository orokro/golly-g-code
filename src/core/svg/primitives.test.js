import { describe, it, expect } from 'vitest';
import svgpath from 'svgpath';
import {
	parsePoints,
	rectToPath,
	circleToPath,
	ellipseToPath,
	lineToPath,
	polylineToPath,
	polygonToPath,
	elementToPathData,
	SUPPORTED_PRIMITIVES,
} from './primitives.js';

/**
 * Minimal stand-in for a DOM element. The real parser hands us xmldom nodes,
 * but nothing here needs more than nodeName + getAttribute.
 */
const el = (nodeName, attrs = {}) => ({
	nodeName,
	getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? String(attrs[k]) : null),
});

/** Commands present in a path, in order, as a compact string like "MLLZ". */
const commandsOf = (d) => {
	const out = [];
	svgpath(d).abs().iterate((seg) => out.push(seg[0]));
	return out.join('');
};

/**
 * Axis-aligned bounds over segment ENDPOINTS, after flattening arcs to cubics.
 *
 * Deliberately ignores bezier control points: the control hull of a cubic
 * approximating a circular arc bulges outside the true arc, so including it
 * would report a circle as larger than it is. unarc() splits at quadrant
 * boundaries, which puts a real endpoint at each extreme -- so endpoints alone
 * give exact bounds for the shapes this module emits.
 */
const boundsOf = (d) => {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

	const add = (px, py) => {
		if (!Number.isFinite(px) || !Number.isFinite(py)) return;
		minX = Math.min(minX, px); maxX = Math.max(maxX, px);
		minY = Math.min(minY, py); maxY = Math.max(maxY, py);
	};

	svgpath(d).unarc().abs().iterate((seg, i, x, y) => {
		switch (seg[0]) {
			case 'M': case 'L': add(seg[1], seg[2]); break;
			case 'H': add(seg[1], y); break;
			case 'V': add(x, seg[1]); break;
			case 'C': add(seg[5], seg[6]); break;
			case 'Q': add(seg[3], seg[4]); break;
			case 'Z': break;
			default: break;
		}
	});

	return { minX, minY, maxX, maxY };
};

/** Every emitted path must actually parse — a silent syntax error would be worse than a throw. */
const assertParses = (d) => {
	const p = svgpath(d);
	expect(p.err, `path data should parse: ${d}`).toBeFalsy();
};


describe('parsePoints', () => {

	it('accepts any mix of commas and whitespace', () => {
		const expected = [[0, 0], [10, 10], [20, 0]];
		expect(parsePoints('0,0 10,10 20,0')).toEqual(expected);
		expect(parsePoints('0 0 10 10 20 0')).toEqual(expected);
		expect(parsePoints('0, 0, 10, 10, 20, 0')).toEqual(expected);
		expect(parsePoints('  0,0\n10,10\t20,0  ')).toEqual(expected);
	});

	it('handles negatives, decimals and exponents', () => {
		expect(parsePoints('-1.5,2e2')).toEqual([[-1.5, 200]]);
	});

	it('drops a dangling odd coordinate rather than throwing', () => {
		expect(parsePoints('0,0 10,10 20')).toEqual([[0, 0], [10, 10]]);
	});

	it('returns empty for junk', () => {
		for (const bad of ['', '   ', null, undefined, 42, {}])
			expect(parsePoints(bad)).toEqual([]);
	});
});


describe('rect', () => {

	it('emits a closed box', () => {
		const d = rectToPath(el('rect', { x: 1, y: 2, width: 10, height: 20 }));
		assertParses(d);
		expect(commandsOf(d)).toBe('MHVHZ');
		expect(boundsOf(d)).toEqual({ minX: 1, minY: 2, maxX: 11, maxY: 22 });
	});

	it('does not render at zero or negative size', () => {
		expect(rectToPath(el('rect', { width: 0, height: 10 }))).toBeNull();
		expect(rectToPath(el('rect', { width: 10, height: 0 }))).toBeNull();
		expect(rectToPath(el('rect', { width: -5, height: 10 }))).toBeNull();
	});

	it('rounds corners with arcs when rx/ry are given', () => {
		const d = rectToPath(el('rect', { width: 100, height: 50, rx: 10, ry: 5 }));
		assertParses(d);
		expect(commandsOf(d)).toBe('MHAVAHAVAZ');
	});

	it('mirrors a single specified radius onto the other axis', () => {
		const onlyRx = rectToPath(el('rect', { width: 100, height: 50, rx: 10 }));
		const onlyRy = rectToPath(el('rect', { width: 100, height: 50, ry: 10 }));
		expect(onlyRx).toBe(onlyRy);
	});

	it('clamps each radius to half its own side', () => {
		const clamped = rectToPath(el('rect', { width: 20, height: 10, rx: 999, ry: 999 }));
		const exact = rectToPath(el('rect', { width: 20, height: 10, rx: 10, ry: 5 }));
		expect(clamped).toBe(exact);
	});

	it('treats a negative radius as unspecified', () => {
		const d = rectToPath(el('rect', { width: 10, height: 10, rx: -5 }));
		expect(commandsOf(d)).toBe('MHVHZ');
	});
});


describe('circle and ellipse', () => {

	it('emits a closed circle with the right bounds', () => {
		const d = circleToPath(el('circle', { cx: 10, cy: 20, r: 5 }));
		assertParses(d);
		const b = boundsOf(d);
		expect(b.minX).toBeCloseTo(5, 6);
		expect(b.maxX).toBeCloseTo(15, 6);
		expect(b.minY).toBeCloseTo(15, 6);
		expect(b.maxY).toBeCloseTo(25, 6);
	});

	it('emits a closed ellipse with independent radii', () => {
		const d = ellipseToPath(el('ellipse', { cx: 0, cy: 0, rx: 30, ry: 10 }));
		assertParses(d);
		const b = boundsOf(d);
		expect(b.minX).toBeCloseTo(-30, 6);
		expect(b.maxX).toBeCloseTo(30, 6);
		expect(b.minY).toBeCloseTo(-10, 6);
		expect(b.maxY).toBeCloseTo(10, 6);
	});

	it('does not render at zero radius', () => {
		expect(circleToPath(el('circle', { r: 0 }))).toBeNull();
		expect(circleToPath(el('circle', { r: -1 }))).toBeNull();
		expect(ellipseToPath(el('ellipse', { rx: 10, ry: 0 }))).toBeNull();
	});
});


describe('line', () => {

	it('is OPEN — no Z', () => {
		const d = lineToPath(el('line', { x1: 0, y1: 0, x2: 10, y2: 10 }));
		assertParses(d);
		expect(commandsOf(d)).toBe('ML');
		expect(d).not.toContain('Z');
	});

	it('does not render when both endpoints coincide', () => {
		expect(lineToPath(el('line', { x1: 5, y1: 5, x2: 5, y2: 5 }))).toBeNull();
	});
});


describe('polyline vs polygon — the open/closed distinction', () => {

	const points = '0,0 10,0 10,10';

	it('polyline stays OPEN', () => {
		const d = polylineToPath(el('polyline', { points }));
		assertParses(d);
		expect(commandsOf(d)).toBe('MLL');
		expect(d).not.toContain('Z');
	});

	it('polygon is CLOSED', () => {
		const d = polygonToPath(el('polygon', { points }));
		assertParses(d);
		expect(commandsOf(d)).toBe('MLLZ');
	});

	it('needs at least two points', () => {
		expect(polylineToPath(el('polyline', { points: '5,5' }))).toBeNull();
		expect(polygonToPath(el('polygon', { points: '' }))).toBeNull();
	});
});


describe('elementToPathData', () => {

	it('handles every primitive jscut rejects', () => {
		// the actual regression this module exists for
		expect(elementToPathData(el('polyline', { points: '0,0 1,1' }))).not.toBeNull();
		expect(elementToPathData(el('polygon', { points: '0,0 1,1 2,0' }))).not.toBeNull();
		expect(elementToPathData(el('circle', { r: 1 }))).not.toBeNull();
		expect(elementToPathData(el('ellipse', { rx: 1, ry: 2 }))).not.toBeNull();
		expect(elementToPathData(el('line', { x2: 1 }))).not.toBeNull();
	});

	it('passes <path> data straight through', () => {
		expect(elementToPathData(el('path', { d: 'M0 0L1 1' }))).toBe('M0 0L1 1');
		expect(elementToPathData(el('path', { d: '  ' }))).toBeNull();
		expect(elementToPathData(el('path', {}))).toBeNull();
	});

	it('ignores namespace prefixes and case', () => {
		expect(elementToPathData(el('svg:rect', { width: 2, height: 2 }))).not.toBeNull();
		expect(elementToPathData(el('RECT', { width: 2, height: 2 }))).not.toBeNull();
	});

	it('throws on a non-geometry element rather than returning null', () => {
		// null means "renders nothing"; an unsupported tag is a different fact and
		// the caller has to be able to tell them apart in order to report it
		expect(() => elementToPathData(el('text', {}))).toThrow(TypeError);
		expect(() => elementToPathData(el('image', {}))).toThrow(TypeError);
	});

	it('every supported name is dispatchable', () => {
		for (const tag of SUPPORTED_PRIMITIVES)
			expect(() => elementToPathData(el(tag, {}))).not.toThrow();
	});
});
