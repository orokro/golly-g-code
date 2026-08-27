import { describe, it, expect } from 'vitest';
import {
	MM_PER_INCH,
	Unit,
	toMillimeters,
	fromMillimeters,
	convert,
	parseLength,
	formatLength,
	formatFractionalInches,
	feedToMillimetersPerMinute,
	feedFromMillimetersPerMinute,
} from './units.js';

describe('conversion', () => {

	it('treats mm as the identity', () => {
		expect(toMillimeters(12.5, Unit.MM)).toBe(12.5);
		expect(fromMillimeters(12.5, Unit.MM)).toBe(12.5);
	});

	it('uses the exact inch definition', () => {
		expect(MM_PER_INCH).toBe(25.4);
		expect(toMillimeters(1, Unit.INCH)).toBe(25.4);
		expect(fromMillimeters(25.4, Unit.INCH)).toBe(1);
	});

	it('round-trips without drift', () => {
		for (const value of [0, 0.001, 0.125, 1, 3.5, 1219.2, -4.25]) {
			expect(fromMillimeters(toMillimeters(value, Unit.INCH), Unit.INCH)).toBeCloseTo(value, 12);
		}
	});

	it('converts between units directly', () => {
		expect(convert(1, Unit.INCH, Unit.MM)).toBe(25.4);
		expect(convert(25.4, Unit.MM, Unit.INCH)).toBe(1);
		expect(convert(7, Unit.MM, Unit.MM)).toBe(7);
	});

	it('rejects unknown units', () => {
		expect(() => toMillimeters(1, 'furlong')).toThrow(TypeError);
		expect(() => fromMillimeters(1, undefined)).toThrow(TypeError);
	});
});

describe('parseLength — plain decimals', () => {

	it('uses the default unit when no suffix is present', () => {
		expect(parseLength('12.5', Unit.MM)).toBe(12.5);
		expect(parseLength('1', Unit.INCH)).toBe(25.4);
	});

	it('defaults to mm', () => {
		expect(parseLength('3')).toBe(3);
	});

	it('handles signs and leading dots', () => {
		expect(parseLength('-2.5', Unit.MM)).toBe(-2.5);
		expect(parseLength('+2.5', Unit.MM)).toBe(2.5);
		expect(parseLength('.5', Unit.MM)).toBe(0.5);
		expect(parseLength('12.', Unit.MM)).toBe(12);
	});

	it('accepts a number directly', () => {
		expect(parseLength(2, Unit.INCH)).toBe(50.8);
		expect(parseLength(Number.NaN)).toBeNaN();
		expect(parseLength(Infinity)).toBeNaN();
	});
});

describe('parseLength — suffixes', () => {

	it('honours an explicit suffix over the default unit', () => {
		expect(parseLength('1in', Unit.MM)).toBe(25.4);
		expect(parseLength('10mm', Unit.INCH)).toBe(10);
	});

	it('tolerates whitespace before the suffix', () => {
		expect(parseLength('3 in')).toBeCloseTo(76.2, 9);
		expect(parseLength('  10  mm  ')).toBe(10);
	});

	it('is case insensitive', () => {
		expect(parseLength('1IN')).toBe(25.4);
		expect(parseLength('10MM')).toBe(10);
	});

	it('does not mistake longer suffixes for shorter ones', () => {
		expect(parseLength('1inch')).toBe(25.4);
		expect(parseLength('2inches')).toBe(50.8);
		expect(parseLength('1m')).toBe(1000);
		expect(parseLength('1mm')).toBe(1);
	});

	it('supports cm, m, ft and quote marks', () => {
		expect(parseLength('2.5cm')).toBe(25);
		expect(parseLength('1m')).toBe(1000);
		expect(parseLength('1ft')).toBeCloseTo(304.8, 10);
		expect(parseLength('0.5"')).toBe(12.7);
		expect(parseLength('2\'')).toBeCloseTo(609.6, 10);
	});
});

describe('parseLength — fractions', () => {

	it('parses proper fractions', () => {
		expect(parseLength('1/2', Unit.INCH)).toBe(12.7);
		expect(parseLength('1/8', Unit.INCH)).toBeCloseTo(3.175, 10);
		expect(parseLength('3/4"')).toBeCloseTo(19.05, 10);
	});

	it('parses hyphenated mixed fractions', () => {
		expect(parseLength('1-1/2', Unit.INCH)).toBeCloseTo(38.1, 9);
		expect(parseLength('2-3/4in')).toBeCloseTo(69.85, 10);
	});

	it('parses space-separated mixed fractions', () => {
		expect(parseLength('1 1/2', Unit.INCH)).toBeCloseTo(38.1, 9);
		expect(parseLength('1 1/2 in')).toBeCloseTo(38.1, 9);
	});

	it('handles negative fractions', () => {
		expect(parseLength('-1/2', Unit.INCH)).toBe(-12.7);
		expect(parseLength('-1-1/2', Unit.INCH)).toBeCloseTo(-38.1, 9);
	});

	it('rejects a zero denominator instead of returning Infinity', () => {
		expect(parseLength('1/0')).toBeNaN();
		expect(parseLength('1-1/0')).toBeNaN();
	});
});

describe('parseLength — rejections', () => {

	it('returns NaN for junk rather than guessing', () => {
		for (const bad of ['', '   ', 'abc', 'mm', '1/2/3', '--3', '3..4', '1 2 3', null, undefined, {}, []]) {
			expect(parseLength(bad)).toBeNaN();
		}
	});
});

describe('formatLength', () => {

	it('trims trailing zeros by default', () => {
		expect(formatLength(1, Unit.MM)).toBe('1');
		expect(formatLength(1.5, Unit.MM)).toBe('1.5');
		expect(formatLength(25.4, Unit.INCH)).toBe('1');
	});

	it('honours an explicit decimal count', () => {
		expect(formatLength(1, Unit.MM, { decimals: 3, trim: false })).toBe('1.000');
		expect(formatLength(25.4, Unit.INCH, { decimals: 4, trim: false })).toBe('1.0000');
	});

	it('appends a suffix on request', () => {
		expect(formatLength(10, Unit.MM, { suffix: true })).toBe('10 mm');
		expect(formatLength(25.4, Unit.INCH, { suffix: true })).toBe('1 in');
	});

	it('never renders negative zero', () => {
		expect(formatLength(-0.00001, Unit.MM)).toBe('0');
	});
});

describe('formatFractionalInches', () => {

	it('renders common bit sizes', () => {
		expect(formatFractionalInches(toMillimeters(0.125, Unit.INCH))).toBe('1/8');
		expect(formatFractionalInches(toMillimeters(0.25, Unit.INCH))).toBe('1/4');
		expect(formatFractionalInches(toMillimeters(0.5, Unit.INCH))).toBe('1/2');
		expect(formatFractionalInches(toMillimeters(0.75, Unit.INCH))).toBe('3/4');
	});

	it('renders whole and mixed values', () => {
		expect(formatFractionalInches(toMillimeters(2, Unit.INCH))).toBe('2');
		expect(formatFractionalInches(toMillimeters(1.5, Unit.INCH))).toBe('1-1/2');
		expect(formatFractionalInches(toMillimeters(2.75, Unit.INCH))).toBe('2-3/4');
	});

	it('handles negatives', () => {
		expect(formatFractionalInches(toMillimeters(-0.5, Unit.INCH))).toBe('-1/2');
	});

	it('falls back to a decimal when nothing fits', () => {
		expect(formatFractionalInches(toMillimeters(0.1234, Unit.INCH))).toBe('0.1234');
	});

	it('carries a round-up into the whole number', () => {
		expect(formatFractionalInches(toMillimeters(0.99999, Unit.INCH))).toBe('1');
	});
});

describe('feed rates', () => {

	it('shares the length conversion factor', () => {
		expect(feedToMillimetersPerMinute(40, Unit.INCH)).toBe(1016);
		expect(feedFromMillimetersPerMinute(1016, Unit.INCH)).toBe(40);
		expect(feedToMillimetersPerMinute(1000, Unit.MM)).toBe(1000);
	});
});
