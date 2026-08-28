/**
 * @file grbl.js
 * @description The GRBL dialect — how a move becomes a line of text.
 *
 * A dialect knows nothing about jobs, passes or tabs. It formats numbers and
 * emits single commands, and `program.js` decides what to ask for. Swapping this
 * module out is how a different controller (or a laser) gets supported (D12).
 *
 * ## What jscut gets wrong here, and it is not cosmetic
 *
 * jscut emits **`G1` at a high feed rate for rapids**, never `G0`. Those are not
 * the same instruction. `G0` asks the controller to get there however it likes
 * and it will use its own rapid acceleration profile; `G1` is a coordinated
 * feed move that the planner treats as cutting. Using `G1` gives up the
 * controller's rapid handling, makes every rapid subject to the same
 * acceleration limits as a cut, and — the part that matters — makes a
 * positioning move indistinguishable from a cutting move to anything reading
 * the file back, including a human. Rapids here are `G0`.
 *
 * It also hard-codes four decimal places, which at 0.0001mm is three orders of
 * magnitude finer than a hobby router resolves and just makes the file bigger.
 */

/**
 * Formats a number for G-code: fixed decimals, with trailing zeros trimmed.
 *
 * Trimming matters more than it looks. `X10.0000` and `X10` are the same move,
 * but a file full of the former is several times larger, and long files take
 * measurable time to stream over serial to a controller with a small buffer.
 *
 * Negative zero is normalised away — `X-0` is legal and alarming to read.
 *
 * @param {Number} value - the number, already in the output unit
 * @param {Number} decimals - places to keep
 * @returns {String} the formatted number
 * @throws {RangeError} when the value is not finite, which means a bug upstream
 *   and must never reach a machine
 */
export function formatNumber(value, decimals) {

	if (!Number.isFinite(value))
		throw new RangeError(`refusing to emit a non-finite coordinate: ${value}`);

	const fixed = value.toFixed(decimals);
	const trimmed = decimals > 0 ? fixed.replace(/\.?0+$/, '') : fixed;

	return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}


/** Millimetres per inch, for the one conversion this module is allowed. */
const MM_PER_INCH = 25.4;


/**
 * Builds a GRBL dialect bound to an output unit and precision.
 *
 * @param {Object} [options] - options
 * @param {String} [options.units='mm'] - `'mm'` or `'inch'`; the only place in
 *   `src/core` where anything leaves millimetres (CONVENTIONS rule 2)
 * @param {Number} [options.decimals=3] - decimal places; 0.001mm is already
 *   finer than a hobby router resolves
 * @returns {Object} the dialect
 * @throws {RangeError} for an unknown unit
 */
export function grbl(options = {}) {

	const { units = 'mm', decimals = 3 } = options;

	if (units !== 'mm' && units !== 'inch')
		throw new RangeError(`unknown output unit '${units}'`);

	const scale = units === 'inch' ? 1 / MM_PER_INCH : 1;
	const n = (millimetres) => formatNumber(millimetres * scale, decimals);

	/**
	 * Assembles the axis words that actually changed.
	 *
	 * Comparison is on the FORMATTED value, not the number: two positions a
	 * nanometre apart produce the same text, and emitting a move between them
	 * would be a zero-length move dressed up as a real one.
	 *
	 * At the start of a program the position is unknown rather than zero, so a
	 * non-finite current value means the axis must be written out. Assuming zero
	 * there would silently drop the first move of a program that begins at the
	 * origin.
	 *
	 * @param {Object} to - target `{ x, y, z }` in millimetres, any may be undefined
	 * @param {Object} from - current position, whose values may be unknown
	 * @returns {String} the axis words, empty when nothing moved
	 */
	const axes = (to, from) => ['x', 'y', 'z']
		.filter((axis) => to[axis] !== undefined
			&& (!Number.isFinite(from[axis]) || n(to[axis]) !== n(from[axis])))
		.map((axis) => `${axis.toUpperCase()}${n(to[axis])}`)
		.join(' ');

	return {

		name: `GRBL, ${units}`,
		units,
		decimals,

		/** @returns {String[]} lines establishing a known machine state */
		preamble: () => [
			units === 'inch' ? 'G20' : 'G21',
			'G90',
			'G17',
			'G94',
		],

		/** @returns {String[]} lines returning the machine to a safe idle state */
		postamble: () => ['M5', 'M2'],

		/**
		 * @param {String} text - comment body
		 * @returns {String} a comment line
		 */
		comment: (text) => `; ${text.replace(/[()\n\r]/g, ' ')}`,

		/**
		 * Rapid positioning — G0, not a fast G1. See the file header.
		 *
		 * @param {Object} to - target `{ x, y, z }` in millimetres
		 * @param {Object} from - current position
		 * @returns {String|null} the line, or null when nothing would move
		 */
		rapid: (to, from) => {
			const words = axes(to, from);
			return words === '' ? null : `G0 ${words}`;
		},

		/**
		 * Coordinated cutting move.
		 *
		 * @param {Object} to - target `{ x, y, z }` in millimetres
		 * @param {Object} from - current position
		 * @param {Number|null} feedRate - feed in mm/min, or null if unchanged
		 * @returns {String|null} the line, or null when nothing would move
		 */
		feed: (to, from, feedRate) => {
			const words = axes(to, from);
			if (words === '')
				return null;
			return `G1 ${words}${feedRate === null ? '' : ` F${n(feedRate)}`}`;
		},

		/**
		 * @param {Number} rpm - spindle speed
		 * @returns {String} the spindle-on line
		 */
		spindleOn: (rpm) => `M3 S${formatNumber(rpm, 0)}`,

		/** @returns {String} the spindle-off line */
		spindleOff: () => 'M5',

		/**
		 * @param {Number} seconds - how long to wait
		 * @returns {String} the dwell line
		 */
		dwell: (seconds) => `G4 P${formatNumber(seconds, 2)}`,

		/**
		 * A tool change. GRBL has no changer, so this is a programmed pause and
		 * the operator does the work; the caller writes the comment saying what
		 * to fit, since only it knows.
		 *
		 * @returns {String[]} the lines
		 */
		toolChange: () => ['M0'],
	};
}
