import { describe, it, expect } from 'vitest';
import {
	IDENTITY, multiply, applyToPoint,
	fromTranslate, fromScale, fromRotate, fromSkewX, fromSkewY,
	parseTransformList, determinant, isUniformScale, toTransformString,
} from './matrix.js';

const closeTo = (actual, expected, digits = 9) => {
	expect(actual[0]).toBeCloseTo(expected[0], digits);
	expect(actual[1]).toBeCloseTo(expected[1], digits);
};


describe('basic operations', () => {

	it('leaves points alone under the identity', () => {
		closeTo(applyToPoint(IDENTITY, [3, 7]), [3, 7]);
	});

	it('translates, scales, rotates and skews', () => {
		closeTo(applyToPoint(fromTranslate(10, 20), [1, 2]), [11, 22]);
		closeTo(applyToPoint(fromScale(2, 3), [1, 2]), [2, 6]);
		closeTo(applyToPoint(fromRotate(90), [1, 0]), [0, 1]);
		closeTo(applyToPoint(fromSkewX(45), [0, 1]), [1, 1]);
		closeTo(applyToPoint(fromSkewY(45), [1, 0]), [1, 1]);
	});

	it('rotates about an arbitrary centre', () => {
		closeTo(applyToPoint(fromRotate(90, 5, 5), [5, 5]), [5, 5]);
		closeTo(applyToPoint(fromRotate(180, 5, 5), [10, 5]), [0, 5]);
	});

	it('scale(n) scales both axes, matching SVG', () => {
		expect(fromScale(3)).toEqual(fromScale(3, 3));
	});
});


describe('composition', () => {

	it('applies the outer transform to the inner one, as SVG nesting does', () => {
		// a child scaled 2x inside a parent translated by 10 lands at 10 + 2*x
		const combined = multiply(fromTranslate(10, 0), fromScale(2));
		closeTo(applyToPoint(combined, [5, 0]), [20, 0]);
	});

	it('is order dependent, in the direction SVG specifies', () => {
		const translateThenScale = multiply(fromTranslate(10, 0), fromScale(2));
		const scaleThenTranslate = multiply(fromScale(2), fromTranslate(10, 0));
		closeTo(applyToPoint(translateThenScale, [0, 0]), [10, 0]);
		closeTo(applyToPoint(scaleThenTranslate, [0, 0]), [20, 0]);
	});

	it('is associative', () => {
		const a = fromTranslate(3, 4);
		const b = fromRotate(37);
		const c = fromScale(2, 5);
		const left = multiply(multiply(a, b), c);
		const right = multiply(a, multiply(b, c));
		for (let i = 0; i < 6; i++)
			expect(left[i]).toBeCloseTo(right[i], 12);
	});
});


describe('parseTransformList', () => {

	it('returns identity for nothing', () => {
		expect(parseTransformList(null)).toEqual([...IDENTITY]);
		expect(parseTransformList('')).toEqual([...IDENTITY]);
		expect(parseTransformList('   ')).toEqual([...IDENTITY]);
	});

	it('parses every transform function', () => {
		closeTo(applyToPoint(parseTransformList('translate(10,20)'), [0, 0]), [10, 20]);
		closeTo(applyToPoint(parseTransformList('translate(10)'), [0, 0]), [10, 0]);
		closeTo(applyToPoint(parseTransformList('scale(2,3)'), [1, 1]), [2, 3]);
		closeTo(applyToPoint(parseTransformList('rotate(90)'), [1, 0]), [0, 1]);
		closeTo(applyToPoint(parseTransformList('rotate(180 5 5)'), [10, 5]), [0, 5]);
		closeTo(applyToPoint(parseTransformList('skewX(45)'), [0, 1]), [1, 1]);
		closeTo(applyToPoint(parseTransformList('matrix(1,0,0,1,5,5)'), [0, 0]), [5, 5]);
	});

	it('accepts whitespace or commas, and no separator between calls', () => {
		const a = parseTransformList('translate(10 20) scale(2)');
		const b = parseTransformList('translate(10,20)scale(2)');
		const c = parseTransformList('  translate( 10 , 20 )   scale( 2 )  ');
		expect(a).toEqual(b);
		expect(a).toEqual(c);
	});

	it('composes a chain left to right', () => {
		// translate first, then rotate within that space
		closeTo(applyToPoint(parseTransformList('translate(10,10) rotate(90)'), [1, 0]), [10, 11]);
	});

	it('rejects anything it does not fully understand', () => {
		// silently ignoring a transform puts geometry somewhere other than the
		// artwork says, and the first sign of it is a ruined workpiece
		for (const bad of [
			'wobble(3)',
			'translate(10,10',
			'rotate(',
			'translate 10 10',
			'matrix(1,0,0,1,5)',
			'translate(1,2,3)',
			'scale(a,b)',
			'translate(10,10) garbage',
		])
			expect(() => parseTransformList(bad), bad).toThrow();
	});
});


describe('matrix properties', () => {

	it('reports the signed area factor', () => {
		expect(determinant(IDENTITY)).toBeCloseTo(1, 12);
		expect(determinant(fromScale(2, 3))).toBeCloseTo(6, 12);
	});

	it('reports a negative determinant for a mirror', () => {
		// a mirrored shape reverses its winding, which flips climb to conventional
		expect(determinant(fromScale(-1, 1))).toBeLessThan(0);
		expect(determinant(fromScale(1, -1))).toBeLessThan(0);
	});

	it('detects uniform scaling', () => {
		expect(isUniformScale(IDENTITY)).toBe(true);
		expect(isUniformScale(fromScale(3))).toBe(true);
		expect(isUniformScale(fromRotate(37))).toBe(true);
		expect(isUniformScale(multiply(fromRotate(20), fromScale(4)))).toBe(true);
	});

	it('detects non-uniform scaling and shear', () => {
		// a circle survives a uniform transform but becomes an ellipse otherwise
		expect(isUniformScale(fromScale(2, 3))).toBe(false);
		expect(isUniformScale(fromSkewX(20))).toBe(false);
	});

	it('round-trips through an SVG transform string', () => {
		const original = multiply(fromTranslate(3, 4), fromRotate(30));
		const parsed = parseTransformList(toTransformString(original));
		for (let i = 0; i < 6; i++)
			expect(parsed[i]).toBeCloseTo(original[i], 12);
	});
});
