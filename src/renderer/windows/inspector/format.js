/**
 * @file format.js
 * @description Turning a stored value into something to type into, and back.
 *
 * The core is millimetres, radians and mm/min, always, and it never converts for
 * anybody (CONVENTIONS.md rule 2). Display units are a presentation concern, so
 * the conversion happens here, at the edge of the UI, and the number that goes
 * back into a command is millimetres again before it leaves this file.
 *
 * jscut is the cautionary tale: six independent unit dropdowns and a
 * `makeAllSameUnit()` to reconcile them. The way you get there is by letting a
 * converted number travel — one function returns inches, its caller does not
 * know, and eventually something multiplies by 25.4 twice.
 *
 * So the rule for everything below: a display value exists between the store and
 * the input, and nowhere else.
 */

import { Unit, convert, feedToMillimetersPerMinute, feedFromMillimetersPerMinute } from '@core/units/units.js';
import { Quantity } from '@core/project/nodes.js';

/** Degrees in a radian. */
const DEGREES = 180 / Math.PI;

/** What to call the unit of each quantity, for the suffix beside a field. */
const LABEL = Object.freeze({
	[Quantity.ANGLE]: '°',
	[Quantity.RPM]: 'rpm',
	[Quantity.FRACTION]: '%',
	[Quantity.SECONDS]: 's',
	[Quantity.COUNT]: '',
	[Quantity.NONE]: '',
});


/**
 * The unit suffix to show beside a field.
 *
 * @param {String} quantity - one of {@link Quantity}
 * @param {String} unit - the display unit, one of {@link Unit}
 * @returns {String} something short, or empty
 */
export function unitLabel(quantity, unit) {

	if (quantity === Quantity.LENGTH)
		return unit === Unit.INCH ? 'in' : 'mm';

	if (quantity === Quantity.FEED)
		return unit === Unit.INCH ? 'in/min' : 'mm/min';

	return LABEL[quantity] ?? '';
}


/**
 * Converts a stored value into what the user should see.
 *
 * @param {Number} value - as stored: millimetres, radians, mm/min, or a fraction
 * @param {String} quantity - one of {@link Quantity}
 * @param {String} [unit=Unit.MM] - the display unit
 * @returns {Number} the number to put in the input
 */
export function toDisplay(value, quantity, unit = Unit.MM) {

	if (Number.isFinite(value) === false)
		return value;

	switch (quantity) {

		case Quantity.LENGTH:
			return convert(value, Unit.MM, unit);

		case Quantity.FEED:
			return feedFromMillimetersPerMinute(value, unit);

		case Quantity.ANGLE:
			return value * DEGREES;

		case Quantity.FRACTION:
			return value * 100;

		default:
			return value;
	}
}


/**
 * Converts what the user typed back into what is stored.
 *
 * @param {Number} value - as shown
 * @param {String} quantity - one of {@link Quantity}
 * @param {String} [unit=Unit.MM] - the display unit
 * @returns {Number} millimetres, radians, mm/min, or a fraction
 */
export function fromDisplay(value, quantity, unit = Unit.MM) {

	if (Number.isFinite(value) === false)
		return value;

	switch (quantity) {

		case Quantity.LENGTH:
			return convert(value, unit, Unit.MM);

		case Quantity.FEED:
			return feedToMillimetersPerMinute(value, unit);

		case Quantity.ANGLE:
			return value / DEGREES;

		case Quantity.FRACTION:
			return value / 100;

		default:
			return value;
	}
}


/**
 * A field's step, in display units.
 *
 * A step of 0.1mm is a sensible nudge; the same step in inches is 0.1 inch,
 * which is two and a half millimetres and far too coarse. Converting the step
 * along with the value keeps the arrow keys meaning roughly the same thing.
 *
 * @param {Object} spec - the FieldSpec
 * @param {String} [unit=Unit.MM] - the display unit
 * @returns {Number|undefined} the step, or undefined when the field has none
 */
export function displayStep(spec, unit = Unit.MM) {

	if (spec.step === undefined)
		return undefined;

	const converted = toDisplay(spec.step, spec.quantity, unit);

	// a converted step lands on numbers like 0.003937; round it to something a
	// human would have chosen, without ever rounding it away to zero
	const magnitude = 10 ** Math.floor(Math.log10(Math.abs(converted)));

	return converted === 0 ? spec.step : Math.max(magnitude, 1e-6);
}


/**
 * How many decimals to show for a quantity.
 *
 * Enough to be lossless at the machine's resolution and no more: a feed rate to
 * three decimals is noise, and a length to none is a lie.
 *
 * @param {String} quantity - one of {@link Quantity}
 * @param {String} [unit=Unit.MM] - the display unit
 * @returns {Number} decimal places
 */
export function decimalsFor(quantity, unit = Unit.MM) {

	if (quantity === Quantity.LENGTH)
		return unit === Unit.INCH ? 4 : 3;

	if (quantity === Quantity.FEED || quantity === Quantity.RPM || quantity === Quantity.COUNT)
		return 0;

	return quantity === Quantity.ANGLE ? 1 : 2;
}


/**
 * A value rendered for an input, without trailing noise.
 *
 * @param {Number} value - as stored
 * @param {String} quantity - one of {@link Quantity}
 * @param {String} [unit=Unit.MM] - the display unit
 * @returns {String} something to put in a text box
 */
export function formatValue(value, quantity, unit = Unit.MM) {

	if (Number.isFinite(value) === false)
		return '';

	const shown = toDisplay(value, quantity, unit);
	const fixed = shown.toFixed(decimalsFor(quantity, unit));

	// 5.000 reads as false precision; 5 is the number
	return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}
