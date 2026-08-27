/**
 * @file units.js
 * @description Length and feed-rate unit handling for the CAM core.
 *
 * The core stores every length in float64 millimetres (see CONVENTIONS.md). This
 * module owns the only conversions in or out of that representation, plus the
 * parsing and formatting used by the UI layer.
 *
 * The parser deliberately accepts fractional and mixed-fraction inches — "1/8",
 * "1-1/2in", '3/4"' — because that is how bit sizes and stock thicknesses are
 * actually written and spoken in a shop. Requiring 0.125 instead of 1/8 is a
 * small, constant papercut for the person using this.
 */

/** Exact millimetres in one inch. This is a definition, not a measurement. */
export const MM_PER_INCH = 25.4;

/**
 * Supported display units.
 *
 * These are presentation-layer only — no geometry function ever takes a unit
 * parameter.
 *
 * @readonly
 * @enum {String}
 */
export const Unit = Object.freeze({
	MM: 'mm',
	INCH: 'inch',
});

/** Multipliers from each supported unit into millimetres. */
const TO_MM = Object.freeze({
	[Unit.MM]: 1,
	[Unit.INCH]: MM_PER_INCH,
});

/**
 * Suffixes the parser understands, mapped to their millimetre multiplier.
 *
 * Ordered longest-first when matched, so "inches" is not mistaken for "in".
 */
const SUFFIX_TO_MM = Object.freeze({
	'millimeters': 1,
	'millimetres': 1,
	'millimeter': 1,
	'millimetre': 1,
	'inches': MM_PER_INCH,
	'inch': MM_PER_INCH,
	'feet': MM_PER_INCH * 12,
	'foot': MM_PER_INCH * 12,
	'mm': 1,
	'cm': 10,
	'in': MM_PER_INCH,
	'ft': MM_PER_INCH * 12,
	'm': 1000,
	'"': MM_PER_INCH,
	'\'': MM_PER_INCH * 12,
	'″': MM_PER_INCH,
	'′': MM_PER_INCH * 12,
});


/**
 * Asserts that a value is a supported unit, throwing if not.
 *
 * @param {String} unit - the unit to check
 * @returns {void}
 * @throws {TypeError} when the unit is not a member of {@link Unit}
 */
function assertUnit(unit) {

	if (Object.prototype.hasOwnProperty.call(TO_MM, unit) === false)
		throw new TypeError(`Unsupported unit: ${String(unit)}`);
}


/**
 * Converts a value from the given display unit into millimetres.
 *
 * @param {Number} value - the value in `unit`
 * @param {String} unit - one of {@link Unit}
 * @returns {Number} the equivalent length in millimetres
 */
export function toMillimeters(value, unit) {

	assertUnit(unit);
	return value * TO_MM[unit];
}


/**
 * Converts a millimetre value into the given display unit.
 *
 * @param {Number} millimeters - the value in millimetres
 * @param {String} unit - one of {@link Unit}
 * @returns {Number} the equivalent length in `unit`
 */
export function fromMillimeters(millimeters, unit) {

	assertUnit(unit);
	return millimeters / TO_MM[unit];
}


/**
 * Converts directly between two display units.
 *
 * @param {Number} value - the value in `fromUnit`
 * @param {String} fromUnit - one of {@link Unit}
 * @param {String} toUnit - one of {@link Unit}
 * @returns {Number} the equivalent value in `toUnit`
 */
export function convert(value, fromUnit, toUnit) {

	return fromMillimeters(toMillimeters(value, fromUnit), toUnit);
}


/**
 * Parses a user-entered length into millimetres.
 *
 * Accepts, with or without internal whitespace:
 *
 * - plain decimals, interpreted in `defaultUnit`  — `12.5`, `-0.03`
 * - an explicit suffix                            — `12.5mm`, `3 in`, `2.5cm`, `1 ft`
 * - quote marks                                   — `0.5"`, `2'`, and their typographic forms
 * - proper fractions                              — `1/8`, `3/4"`
 * - mixed fractions, hyphen or space separated    — `1-1/2`, `1 1/2 in`
 *
 * @param {String|Number} input - the raw user input
 * @param {String} [defaultUnit=Unit.MM] - unit assumed when the input carries no suffix
 * @returns {Number} the parsed length in millimetres, or NaN if unparseable
 */
export function parseLength(input, defaultUnit = Unit.MM) {

	assertUnit(defaultUnit);

	// numbers pass straight through, interpreted in the default unit
	if (typeof input === 'number')
		return Number.isFinite(input) ? toMillimeters(input, defaultUnit) : Number.NaN;

	if (typeof input !== 'string')
		return Number.NaN;

	let text = input.trim().toLowerCase();
	if (text === '')
		return Number.NaN;

	// ---- split off a trailing unit suffix, longest match first ----------
	let multiplier = TO_MM[defaultUnit];

	const suffixes = Object.keys(SUFFIX_TO_MM).sort((a, b) => b.length - a.length);
	for (const suffix of suffixes) {

		if (text.endsWith(suffix) === true) {
			multiplier = SUFFIX_TO_MM[suffix];
			text = text.slice(0, -suffix.length).trim();
			break;
		}
	}

	if (text === '')
		return Number.NaN;

	// ---- capture and strip a leading sign -------------------------------
	let sign = 1;
	if (text.startsWith('-') === true) {
		sign = -1;
		text = text.slice(1).trim();
	} else if (text.startsWith('+') === true) {
		text = text.slice(1).trim();
	}

	// ---- mixed fraction: "1-1/2" or "1 1/2" -----------------------------
	const mixed = text.match(/^(\d+)\s*[-\s]\s*(\d+)\s*\/\s*(\d+)$/);
	if (mixed !== null) {

		const denominator = Number(mixed[3]);
		if (denominator === 0)
			return Number.NaN;

		const magnitude = Number(mixed[1]) + (Number(mixed[2]) / denominator);
		return sign * magnitude * multiplier;
	}

	// ---- proper fraction: "3/4" -----------------------------------------
	const fraction = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
	if (fraction !== null) {

		const denominator = Number(fraction[2]);
		if (denominator === 0)
			return Number.NaN;

		return sign * (Number(fraction[1]) / denominator) * multiplier;
	}

	// ---- plain decimal ---------------------------------------------------
	const decimal = text.match(/^(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/);
	if (decimal !== null)
		return sign * Number(text) * multiplier;

	return Number.NaN;
}


/**
 * Formats a millimetre value for display.
 *
 * @param {Number} millimeters - the value in millimetres
 * @param {String} unit - one of {@link Unit}
 * @param {Object} [options] - formatting options
 * @param {Number} [options.decimals] - fixed decimal places; defaults to 3 for mm and 4 for inch
 * @param {Boolean} [options.suffix=false] - append the unit suffix
 * @param {Boolean} [options.trim=true] - strip trailing zeros from the fractional part
 * @returns {String} the formatted value
 */
export function formatLength(millimeters, unit, options = {}) {

	assertUnit(unit);

	const {
		decimals = (unit === Unit.INCH ? 4 : 3),
		suffix = false,
		trim = true,
	} = options;

	const value = fromMillimeters(millimeters, unit);

	let text = value.toFixed(decimals);

	if (trim === true && text.includes('.') === true)
		text = text.replace(/\.?0+$/, '');

	// toFixed on a small negative can produce "-0"; nobody wants to read that
	if (text === '-0')
		text = '0';

	return suffix === true ? `${text} ${unit === Unit.INCH ? 'in' : 'mm'}` : text;
}


/**
 * Formats a millimetre value as a mixed fraction of an inch.
 *
 * Intended for tool-diameter and stock-thickness displays, where `1/8"` reads
 * better than `0.125"`. Falls back to a decimal string when the value does not
 * land close enough to a fraction of `denominator`.
 *
 * @param {Number} millimeters - the value in millimetres
 * @param {Number} [denominator=64] - largest fraction denominator to consider
 * @param {Number} [tolerance=0.0005] - maximum acceptable error, in inches
 * @returns {String} something like `1-1/2`, `3/4`, `2`, or a decimal fallback
 */
export function formatFractionalInches(millimeters, denominator = 64, tolerance = 0.0005) {

	const inches = fromMillimeters(millimeters, Unit.INCH);
	const sign = inches < 0 ? '-' : '';
	const magnitude = Math.abs(inches);

	const whole = Math.floor(magnitude);
	const remainder = magnitude - whole;

	const numerator = Math.round(remainder * denominator);

	// rounding up can carry into the whole number (e.g. 63.9/64 -> 64/64)
	if (numerator >= denominator)
		return `${sign}${whole + 1}`;

	if (Math.abs((numerator / denominator) - remainder) > tolerance)
		return `${sign}${magnitude.toFixed(4).replace(/\.?0+$/, '')}`;

	if (numerator === 0)
		return `${sign}${whole}`;

	// reduce the fraction
	let n = numerator;
	let d = denominator;
	const divisor = greatestCommonDivisor(n, d);
	n /= divisor;
	d /= divisor;

	return whole === 0 ? `${sign}${n}/${d}` : `${sign}${whole}-${n}/${d}`;
}


/**
 * Euclidean greatest common divisor, used to reduce displayed fractions.
 *
 * @param {Number} a - first operand
 * @param {Number} b - second operand
 * @returns {Number} the greatest common divisor of `a` and `b`
 */
function greatestCommonDivisor(a, b) {

	while (b !== 0) {
		const t = b;
		b = a % b;
		a = t;
	}

	return a;
}


/**
 * Converts a feed rate from a display unit into the internal mm/min.
 *
 * @param {Number} value - the rate in `unit` per minute
 * @param {String} unit - one of {@link Unit}
 * @returns {Number} the rate in millimetres per minute
 */
export function feedToMillimetersPerMinute(value, unit) {

	return toMillimeters(value, unit);
}


/**
 * Converts an internal mm/min feed rate into a display unit per minute.
 *
 * @param {Number} millimetersPerMinute - the internal rate
 * @param {String} unit - one of {@link Unit}
 * @returns {Number} the rate in `unit` per minute
 */
export function feedFromMillimetersPerMinute(millimetersPerMinute, unit) {

	return fromMillimeters(millimetersPerMinute, unit);
}
