import { describe, it, expect } from 'vitest';
import {
	normalizePathData,
	quadraticToCubic,
	countOpenSubPaths,
	DEFAULT_COINCIDENCE_TOLERANCE,
} from './normalize.js';
import { evaluateCubic, flattenSubPath } from './flatten.js';

/** Compact command string for a subpath, e.g. "LLC". */
const kinds = (subPath) => subPath.segments.map((s) => s.type).join('');


describe('command expansion', () => {

	it('turns H and V into real lines with the inherited axis', () => {
		const { subPaths } = normalizePathData('M10 10 H50 V50');
		expect(subPaths).toHaveLength(1);
		expect(kinds(subPaths[0])).toBe('LL');
		expect(subPaths[0].segments[0].to).toEqual([50, 10]);
		expect(subPaths[0].segments[1].to).toEqual([50, 50]);
	});

	it('converts relative commands to absolute', () => {
		const { subPaths } = normalizePathData('m10 10 l10 0 l0 10');
		expect(subPaths[0].start).toEqual([10, 10]);
		expect(subPaths[0].segments[0].to).toEqual([20, 10]);
		expect(subPaths[0].segments[1].to).toEqual([20, 20]);
	});

	it('expands S and T shorthands', () => {
		const { subPaths } = normalizePathData('M0 0 C10 0 20 10 20 20 S30 40 40 40');
		expect(kinds(subPaths[0])).toBe('CC');
	});

	it('keeps elliptical arcs as arcs rather than approximating them', () => {
		// converting to cubics here would bake in ~0.00027*r of radial error that
		// the flattener cannot see; see the header of arc.js
		const { subPaths } = normalizePathData('M0 0 A20 20 0 0 1 40 0');
		expect(subPaths[0].segments).toHaveLength(1);
		expect(subPaths[0].segments[0].type).toBe('A');
		expect(subPaths[0].segments[0].arc.rx).toBeCloseTo(20, 9);
	});

	it('enlarges radii too small to span the endpoints, per spec', () => {
		// (10,10) to (50,50) is 56.6 apart; a radius of 20 cannot reach, so the
		// spec says scale up until it exactly does rather than reject the arc
		const { subPaths } = normalizePathData('M10 10 A20 20 0 0 1 50 50');
		expect(subPaths[0].segments[0].arc.rx).toBeCloseTo(Math.hypot(40, 40) / 2, 9);
	});

	it('degrades a zero-radius arc to a line, as the spec requires', () => {
		const { subPaths } = normalizePathData('M0 0 A0 0 0 0 1 10 10');
		expect(subPaths[0].segments[0].type).toBe('L');
		expect(subPaths[0].segments[0].to).toEqual([10, 10]);
	});

	it('leaves straight lines as lines rather than promoting them to curves', () => {
		// a line needs no subdivision when flattening and is exactly representable
		// when fitting arcs later; promoting it would throw that away
		const { subPaths } = normalizePathData('M0 0 L10 0 L10 10');
		expect(kinds(subPaths[0])).toBe('LL');
	});
});


describe('quadratic to cubic elevation', () => {

	it('is exact, not an approximation', () => {
		const from = [0, 0];
		const control = [10, 20];
		const to = [20, 0];
		const cubic = quadraticToCubic(from, control, to);

		// sample both forms and compare; any error would show up immediately
		for (let i = 0; i <= 20; i++) {
			const t = i / 20;
			const u = 1 - t;

			const qx = (u * u * from[0]) + (2 * u * t * control[0]) + (t * t * to[0]);
			const qy = (u * u * from[1]) + (2 * u * t * control[1]) + (t * t * to[1]);

			const [cx, cy] = evaluateCubic(from, cubic.c1, cubic.c2, cubic.to, t);

			expect(cx).toBeCloseTo(qx, 12);
			expect(cy).toBeCloseTo(qy, 12);
		}
	});

	it('is applied to Q commands in path data', () => {
		const { subPaths } = normalizePathData('M0 0 Q10 20 20 0');
		expect(kinds(subPaths[0])).toBe('C');
	});
});


describe('open versus closed — the distinction jscut loses', () => {

	it('marks an explicit Z as closed, and says so', () => {
		const { subPaths } = normalizePathData('M0 0 L10 0 L10 10 Z');
		expect(subPaths[0].closed).toBe(true);
		expect(subPaths[0].closedBy).toBe('z');
	});

	it('leaves an unterminated path OPEN', () => {
		const { subPaths } = normalizePathData('M0 0 L10 0 L10 10');
		expect(subPaths[0].closed).toBe(false);
		expect(subPaths[0].closedBy).toBeNull();
	});

	it('infers closure when the endpoints genuinely coincide, and distinguishes it', () => {
		// "the artist closed this" and "this happens to end where it started" are
		// different facts, so they get different labels
		const { subPaths } = normalizePathData('M0 0 L10 0 L10 10 L0 0');
		expect(subPaths[0].closed).toBe(true);
		expect(subPaths[0].closedBy).toBe('coincident');
	});

	it('does not stitch together endpoints that merely sit near each other', () => {
		const { subPaths } = normalizePathData('M0 0 L10 0 L10 10 L0.5 0.5');
		expect(subPaths[0].closed).toBe(false);
	});

	it('adds the closing edge as a real segment so it exists for offsetting', () => {
		const { subPaths } = normalizePathData('M0 0 L10 0 L10 10 Z');
		const last = subPaths[0].segments[subPaths[0].segments.length - 1];
		expect(last.to).toEqual([0, 0]);
	});

	it('counts open subpaths for the UI', () => {
		const { subPaths } = normalizePathData('M0 0 L10 0 Z M20 20 L30 20 M40 40 L50 40');
		expect(subPaths).toHaveLength(3);
		expect(countOpenSubPaths(subPaths)).toBe(2);
	});
});


describe('subpaths', () => {

	it('splits on each moveto', () => {
		const { subPaths } = normalizePathData('M0 0 L10 0 M20 20 L30 20');
		expect(subPaths).toHaveLength(2);
		expect(subPaths[0].start).toEqual([0, 0]);
		expect(subPaths[1].start).toEqual([20, 20]);
	});

	it('handles a closed subpath followed by another', () => {
		const { subPaths } = normalizePathData('M0 0 L10 0 L10 10 Z M20 20 L30 20 L30 30 Z');
		expect(subPaths).toHaveLength(2);
		expect(subPaths.every((s) => s.closed)).toBe(true);
	});

	it('drops zero-length segments', () => {
		const { subPaths } = normalizePathData('M0 0 L0 0 L10 0');
		expect(kinds(subPaths[0])).toBe('L');
	});

	it('drops a lone moveto and says so instead of emitting an empty shape', () => {
		const { subPaths, warnings } = normalizePathData('M10 10');
		expect(subPaths).toHaveLength(0);
		expect(warnings.join(' ')).toMatch(/empty subpath/i);
	});
});


describe('transforms', () => {

	it('applies an SVG transform attribute', () => {
		const { subPaths } = normalizePathData('M0 0 L10 0', { transform: 'translate(10,20)' });
		expect(subPaths[0].start).toEqual([10, 20]);
		expect(subPaths[0].segments[0].to).toEqual([20, 20]);
	});

	it('handles chained transforms', () => {
		const { subPaths } = normalizePathData('M0 0 L10 0', { transform: 'translate(10,10) scale(2)' });
		expect(subPaths[0].segments[0].to[0]).toBeCloseTo(30, 9);
	});

	it('re-parameterizes an arc under non-uniform scale rather than distorting an approximation', () => {
		const plain = normalizePathData('M0 0 A10 10 0 0 1 20 0');
		const scaled = normalizePathData('M0 0 A10 10 0 0 1 20 0', { transform: 'scale(2,3)' });

		// A scaled circle is a genuine ellipse, and may legitimately be expressed
		// as a rotated one (rx=30, ry=20, rotation=90 is the same shape as rx=20,
		// ry=30, rotation=0). So assert the SHAPE via its bounds, which no choice
		// of representation can fudge, rather than the labels on its axes.
		const extent = (result) => {
			const { points } = flattenSubPath(result.subPaths[0], { tolerance: 0.001 });
			const xs = points.map((p) => p[0]);
			const ys = points.map((p) => p[1]);
			return {
				width: Math.max(...xs) - Math.min(...xs),
				height: Math.max(...ys) - Math.min(...ys),
			};
		};

		const before = extent(plain);
		const after = extent(scaled);

		// A flattened arc is INSCRIBED in the true curve, so a measured extent is
		// always a shade under. Allow the flattening tolerance itself (0.001) --
		// asserting tighter than the tolerance we asked for would be nonsense.
		const slack = 0.002;
		expect(Math.abs(after.width - (before.width * 2))).toBeLessThanOrEqual(slack);
		expect(Math.abs(after.height - (before.height * 3))).toBeLessThanOrEqual(slack);
	});
});


describe('failure handling', () => {

	it('returns empty with a note for empty input rather than throwing', () => {
		for (const empty of ['', '   ', null, undefined]) {
			const { subPaths, warnings } = normalizePathData(empty);
			expect(subPaths).toHaveLength(0);
			expect(warnings.length).toBeGreaterThan(0);
		}
	});

	it('throws on unparseable data instead of silently producing nothing', () => {
		// a silent empty result here would become a silently missing cut
		expect(() => normalizePathData('garbage')).toThrow(/parse/i);
		expect(() => normalizePathData('M0 0 L')).toThrow(/parse/i);
	});

	it('throws on a malformed transform instead of silently ignoring it', () => {
		// svgpath quietly drops a transform it cannot parse, which would place
		// geometry somewhere other than the artwork says with no warning at all
		for (const bad of ['rotate(', 'translate(10,10', 'wobble(3)', 'translate 10 10'])
			expect(() => normalizePathData('M0 0 L1 1', { transform: bad }), bad).toThrow(/transform/i);
	});

	it('accepts the real transform-list grammar', () => {
		for (const good of [
			'translate(10,20)', 'translate(10 20)', 'scale(2)', 'rotate(45 5 5)',
			'skewX(10)', 'matrix(1,0,0,1,5,5)', 'translate(10,10) rotate(45) scale(2)',
			'translate(10 10)rotate(45)',
		])
			expect(() => normalizePathData('M0 0 L1 1', { transform: good }), good).not.toThrow();
	});

	it('exposes its coincidence tolerance', () => {
		expect(DEFAULT_COINCIDENCE_TOLERANCE).toBeGreaterThan(0);
	});
});
