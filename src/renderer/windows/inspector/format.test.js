import { describe, it, expect } from 'vitest';

import { Unit, MM_PER_INCH } from '@core/units/units.js';
import { Quantity, FIELDS, NodeType } from '@core/project/nodes.js';

import { unitLabel, toDisplay, fromDisplay, displayStep, decimalsFor, formatValue } from './format.js';


describe('showing a stored value', () => {

	it('converts lengths and feeds, and leaves the rest alone', () => {
		expect(toDisplay(25.4, Quantity.LENGTH, Unit.INCH)).toBeCloseTo(1, 9);
		expect(toDisplay(25.4, Quantity.LENGTH, Unit.MM)).toBeCloseTo(25.4, 9);
		expect(toDisplay(MM_PER_INCH * 60, Quantity.FEED, Unit.INCH)).toBeCloseTo(60, 6);
		expect(toDisplay(18000, Quantity.RPM, Unit.INCH)).toBe(18000);
	});

	it('shows angles in degrees, because radians are for the core', () => {
		expect(toDisplay(Math.PI / 2, Quantity.ANGLE)).toBeCloseTo(90, 9);
		expect(fromDisplay(90, Quantity.ANGLE)).toBeCloseTo(Math.PI / 2, 12);
	});

	it('shows fractions as percentages', () => {
		expect(toDisplay(0.4, Quantity.FRACTION)).toBeCloseTo(40, 9);
		expect(fromDisplay(40, Quantity.FRACTION)).toBeCloseTo(0.4, 12);
	});

	it('leaves a value that is not a number alone rather than making one up', () => {
		expect(toDisplay(undefined, Quantity.LENGTH)).toBeUndefined();
		expect(fromDisplay(NaN, Quantity.LENGTH)).toBeNaN();
	});
});


describe('the round trip', () => {

	it('comes back to where it started, for every quantity and unit', () => {
		// the only property that matters here: a number that goes out to an input
		// and comes back must be the number it was, or every edit drifts
		for (const quantity of Object.values(Quantity))
			for (const unit of Object.values(Unit))
				for (const value of [0, 1, 3.175, 1000, 0.4, 18_000]) {
					const back = fromDisplay(toDisplay(value, quantity, unit), quantity, unit);
					expect(back, `${quantity} ${unit} ${value}`).toBeCloseTo(value, 9);
				}
	});
});


describe('the unit beside the field', () => {

	it('says what the number is in', () => {
		expect(unitLabel(Quantity.LENGTH, Unit.MM)).toBe('mm');
		expect(unitLabel(Quantity.LENGTH, Unit.INCH)).toBe('in');
		expect(unitLabel(Quantity.FEED, Unit.INCH)).toBe('in/min');
		expect(unitLabel(Quantity.ANGLE, Unit.MM)).toBe('°');
		expect(unitLabel(Quantity.FRACTION, Unit.MM)).toBe('%');
	});

	it('says nothing for a number with no unit', () => {
		expect(unitLabel(Quantity.NONE, Unit.MM)).toBe('');
		expect(unitLabel(Quantity.COUNT, Unit.MM)).toBe('');
	});
});


describe('the step the arrow keys use', () => {

	it('converts with the value, so a nudge means the same thing', () => {
		// 0.1mm is a sensible nudge; 0.1 INCH is two and a half millimetres
		const spec = { step: 0.1, quantity: Quantity.LENGTH };

		expect(displayStep(spec, Unit.MM)).toBeCloseTo(0.1, 9);
		expect(displayStep(spec, Unit.INCH)).toBeLessThan(0.01);
		expect(displayStep(spec, Unit.INCH)).toBeGreaterThan(0);
	});

	it('never rounds a step away to nothing', () => {
		for (const [type, fields] of Object.entries(FIELDS))
			for (const [field, spec] of Object.entries(fields))
				if (spec.step !== undefined)
					for (const unit of Object.values(Unit))
						expect(displayStep(spec, unit), `${type}.${field} in ${unit}`).toBeGreaterThan(0);
	});

	it('has none where the field has none', () => {
		expect(displayStep({ quantity: Quantity.NONE })).toBeUndefined();
	});
});


describe('rendering a number for a box', () => {

	it('drops trailing zeros, because 5.000 reads as false precision', () => {
		expect(formatValue(5, Quantity.LENGTH, Unit.MM)).toBe('5');
		expect(formatValue(3.175, Quantity.LENGTH, Unit.MM)).toBe('3.175');
		expect(formatValue(1000, Quantity.FEED, Unit.MM)).toBe('1000');
	});

	it('keeps enough decimals to be lossless at the machine’s resolution', () => {
		expect(decimalsFor(Quantity.LENGTH, Unit.MM)).toBe(3);
		expect(decimalsFor(Quantity.LENGTH, Unit.INCH)).toBe(4);
		expect(decimalsFor(Quantity.FEED, Unit.MM)).toBe(0);
	});

	it('shows a tool diameter in inches as the fraction it is', () => {
		// 3.175mm is exactly an eighth of an inch, and it should look like it
		expect(formatValue(3.175, Quantity.LENGTH, Unit.INCH)).toBe('0.125');
	});

	it('shows an empty box rather than NaN', () => {
		expect(formatValue(undefined, Quantity.LENGTH)).toBe('');
		expect(formatValue(NaN, Quantity.LENGTH)).toBe('');
	});

	it('shows every default in both units without producing nonsense', () => {
		for (const [type, fields] of Object.entries(FIELDS))
			for (const [field, spec] of Object.entries(fields))
				if (typeof spec.default === 'number')
					for (const unit of Object.values(Unit))
						expect(formatValue(spec.default, spec.quantity, unit), `${type}.${field}`)
							.toMatch(/^-?\d+(\.\d+)?$/);
	});

	it('round-trips a tool diameter typed in inches', () => {
		const spec = FIELDS[NodeType.TOOL].diameter;
		const shown = formatValue(spec.default, spec.quantity, Unit.INCH);

		expect(fromDisplay(Number(shown), spec.quantity, Unit.INCH)).toBeCloseTo(3.175, 6);
	});
});
