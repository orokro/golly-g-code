/**
 * @file viewport.js
 * @description Works out how big an SVG actually is, in millimetres.
 *
 * jscut ignores `width`, `height` and `viewBox` entirely and asks the user to
 * type a "px per inch" number. That is half wrong and half unavoidable, and the
 * distinction matters:
 *
 * **Half wrong.** `width="100mm" viewBox="0 0 200 100"` is not ambiguous at all.
 * It is 100mm wide, so one user unit is half a millimetre. Any file that states
 * a real physical unit tells us its size exactly, and asking the user to guess
 * is throwing away information the document already gave us.
 *
 * **Half unavoidable.** `width="612" viewBox="0 0 612 792"` states no unit, and
 * is equally self-consistent read as 612 CSS pixels (161.9mm at 96dpi) or 612
 * points (215.9mm at 72dpi — US Letter). Illustrator has historically written
 * exactly this, which is why jscut users have to set 72 for Illustrator files
 * and 96 for Inkscape ones. Nothing in the file resolves it, so the user has to.
 *
 * So we do both: read the size exactly when the document states real units, and
 * expose `pixelsPerInch` for when it does not. `dpiDependent` on the result says
 * which case you are in, so a UI can offer the control only when it would
 * actually change something instead of always asking.
 *
 * It also performs the y flip. SVG is y-down; everything past this point is
 * y-up (see CONVENTIONS.md). Doing it here means exactly one place in the
 * codebase ever reasons in SVG's coordinate system. jscut instead carried y-down
 * all the way to a `-p.Y * scale` in the G-code emitter, leaving every
 * intermediate stage in a different space from its own output.
 */

import { multiply, fromScale, fromTranslate } from './matrix.js';
import { MM_PER_INCH } from '../units/units.js';

/**
 * CSS pixels per inch, per the CSS specification.
 *
 * The default assumption for unitless lengths. Overridable, because some
 * applications write unitless values meaning points at 72 per inch.
 */
export const CSS_PX_PER_INCH = 96;

/** Common `pixelsPerInch` values, for a UI to offer as presets. */
export const COMMON_DPI = Object.freeze([
	{ value: 96, label: '96 — CSS standard, Inkscape 0.92+' },
	{ value: 72, label: '72 — points, Adobe Illustrator' },
	{ value: 90, label: '90 — Inkscape 0.91 and earlier' },
]);

/** Millimetres in one CSS pixel. */
export const MM_PER_PX = MM_PER_INCH / CSS_PX_PER_INCH;

/**
 * Absolute length units that state a real physical size, in millimetres each.
 *
 * `px` and the empty unit are deliberately absent: those depend on an assumed
 * resolution and are handled separately.
 */
const PHYSICAL_UNIT_TO_MM = Object.freeze({
	mm: 1,
	cm: 10,
	q: 10 / 40,
	in: MM_PER_INCH,
	pt: MM_PER_INCH / 72,
	pc: MM_PER_INCH / 6,
});


/**
 * Parses a length attribute such as `100mm`, `8.5in` or `640`.
 *
 * Relative units (%, em, ex, rem, vw, vh) are rejected: at the document root
 * they resolve against a containing block that does not exist here.
 *
 * @param {String|null|undefined} raw - the raw attribute value
 * @param {Number} [pixelsPerInch=CSS_PX_PER_INCH] - resolution assumed for
 *   unitless and `px` values
 * @returns {Object|null} `{ millimeters, unit, dpiDependent }`, or null if the
 *   value is absent, relative, or unparseable
 */
export function parseLength(raw, pixelsPerInch = CSS_PX_PER_INCH) {

	if (raw === null || raw === undefined)
		return null;

	const text = String(raw).trim().toLowerCase();
	if (text === '')
		return null;

	const match = text.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-z%]*)$/);
	if (match === null)
		return null;

	const value = Number.parseFloat(match[1]);
	const unit = match[2];

	if (Number.isFinite(value) === false)
		return null;

	// no unit, or px: the physical size depends on an assumed resolution
	if (unit === '' || unit === 'px') {
		return {
			millimeters: value * (MM_PER_INCH / pixelsPerInch),
			unit: unit === '' ? null : 'px',
			dpiDependent: true,
		};
	}

	if (Object.prototype.hasOwnProperty.call(PHYSICAL_UNIT_TO_MM, unit) === false)
		return null;

	// a real physical unit; the document has told us its size outright
	return { millimeters: value * PHYSICAL_UNIT_TO_MM[unit], unit, dpiDependent: false };
}


/**
 * Convenience wrapper returning just the millimetre value.
 *
 * @param {String|null|undefined} raw - the raw attribute value
 * @param {Number} [pixelsPerInch=CSS_PX_PER_INCH] - resolution for unitless values
 * @returns {Number|null} the length in millimetres, or null
 */
export function parseLengthToMillimeters(raw, pixelsPerInch = CSS_PX_PER_INCH) {

	return parseLength(raw, pixelsPerInch)?.millimeters ?? null;
}


/**
 * Parses a `viewBox` attribute.
 *
 * @param {String|null|undefined} raw - the raw attribute value
 * @returns {Object|null} `{ minX, minY, width, height }`, or null if unusable
 */
export function parseViewBox(raw) {

	if (raw === null || raw === undefined)
		return null;

	const parts = String(raw)
		.trim()
		.split(/[\s,]+/)
		.filter((token) => token !== '')
		.map(Number);

	if (parts.length !== 4 || parts.some((n) => Number.isFinite(n) === false))
		return null;

	const [minX, minY, width, height] = parts;

	// spec: a zero width or height disables rendering, a negative one is an error
	if (width <= 0 || height <= 0)
		return null;

	return { minX, minY, width, height };
}


/**
 * Parses `preserveAspectRatio`.
 *
 * @param {String|null|undefined} raw - the raw attribute value
 * @returns {Object} `{ align, meetOrSlice }`, defaulting to `xMidYMid meet`
 */
export function parsePreserveAspectRatio(raw) {

	const text = String(raw ?? '').trim();

	if (text === '')
		return { align: 'xMidYMid', meetOrSlice: 'meet' };

	const parts = text.split(/\s+/);

	// the optional leading 'defer' keyword only applies to <image>, and is ignored
	const align = parts[0] === 'defer' ? (parts[1] ?? 'xMidYMid') : parts[0];
	const meetOrSlice = parts[parts.length - 1] === 'slice' ? 'slice' : 'meet';

	return { align: align || 'xMidYMid', meetOrSlice };
}


/**
 * Alignment fraction for one axis: 0 for Min, 0.5 for Mid, 1 for Max.
 *
 * @param {String} align - the align keyword, e.g. `xMidYMax`
 * @param {String} axis - 'x' or 'y'
 * @returns {Number} the fraction of leftover space placed before the content
 */
function alignFraction(align, axis) {

	if (align === 'none')
		return 0;

	const marker = axis === 'x' ? align.slice(1, 4) : align.slice(5, 8);

	if (marker === 'Mid')
		return 0.5;
	if (marker === 'Max')
		return 1;

	return 0;
}


/**
 * Assembles the user-unit-to-millimetre matrix, including the y flip.
 *
 * @param {Object} viewBox - the resolved view box
 * @param {Number} scaleX - x scale, mm per user unit
 * @param {Number} scaleY - y scale, mm per user unit
 * @param {Number} offsetX - alignment offset in mm
 * @param {Number} offsetY - alignment offset in mm
 * @param {Number} physicalHeight - viewport height in mm, the axis flipped about
 * @returns {Object} `{ matrix, scaleX, scaleY }`
 */
function buildMatrix(viewBox, scaleX, scaleY, offsetX, offsetY, physicalHeight) {

	// read right to left: move the viewBox origin to zero, scale into millimetres
	// with y negated, then push back up by the viewport height so the flipped
	// content lands in positive y with its origin at the bottom-left
	const matrix = multiply(
		multiply(
			fromTranslate(offsetX, physicalHeight - offsetY),
			fromScale(scaleX, -scaleY),
		),
		fromTranslate(-viewBox.minX, -viewBox.minY),
	);

	return { matrix, scaleX, scaleY };
}


/**
 * Resolves an SVG root element into a user-unit-to-millimetre transform.
 *
 * The returned matrix also flips the y axis, so its output is already in the
 * y-up space the rest of the core works in.
 *
 * @param {Object} svgElement - the root `<svg>`, a DOM-like element
 * @param {Object} [options] - options
 * @param {Number} [options.pixelsPerInch=CSS_PX_PER_INCH] - resolution assumed for
 *   unitless and `px` lengths. Ignored entirely when the document states a real
 *   physical unit, since then there is nothing to assume.
 * @returns {Object} `{ matrix, scaleX, scaleY, viewBox, physical, source,
 *   dpiDependent, pixelsPerInch, warnings }`
 */
export function resolveViewport(svgElement, options = {}) {

	const { pixelsPerInch = CSS_PX_PER_INCH } = options ?? {};

	if (!(pixelsPerInch > 0))
		throw new RangeError(`pixelsPerInch must be positive, got ${pixelsPerInch}`);

	const perPixel = MM_PER_INCH / pixelsPerInch;

	/** @type {String[]} */
	const warnings = [];

	const rawWidth = svgElement.getAttribute('width');
	const rawHeight = svgElement.getAttribute('height');

	const width = parseLength(rawWidth, pixelsPerInch);
	const height = parseLength(rawHeight, pixelsPerInch);

	const widthMm = width?.millimeters ?? null;
	const heightMm = height?.millimeters ?? null;
	const viewBox = parseViewBox(svgElement.getAttribute('viewBox'));

	if (rawWidth !== null && widthMm === null)
		warnings.push(`Could not read width="${rawWidth}"; it may use a relative unit`);
	if (rawHeight !== null && heightMm === null)
		warnings.push(`Could not read height="${rawHeight}"; it may use a relative unit`);

	// ---- case 1: a stated physical size AND a viewBox --------------------
	// the fully unambiguous case, and precisely the information jscut discards
	if (widthMm !== null && heightMm !== null && viewBox !== null) {

		const { align, meetOrSlice } = parsePreserveAspectRatio(
			svgElement.getAttribute('preserveAspectRatio'),
		);

		let scaleX = widthMm / viewBox.width;
		let scaleY = heightMm / viewBox.height;

		let offsetX = 0;
		let offsetY = 0;

		if (align !== 'none') {

			// uniform scaling: 'meet' fits the content inside the viewport,
			// 'slice' fills the viewport and lets the content overflow
			const uniform = meetOrSlice === 'slice'
				? Math.max(scaleX, scaleY)
				: Math.min(scaleX, scaleY);

			// the space a uniform scale leaves over is distributed per the keyword
			offsetX = (widthMm - (viewBox.width * uniform)) * alignFraction(align, 'x');
			offsetY = (heightMm - (viewBox.height * uniform)) * alignFraction(align, 'y');

			scaleX = uniform;
			scaleY = uniform;
		}

		const dpiDependent = (width.dpiDependent === true) || (height.dpiDependent === true);

		if (dpiDependent === true) {
			warnings.push(
				'Size is stated without a physical unit, so it depends on an assumed '
				+ `${pixelsPerInch} px/inch. Illustrator files usually mean 72; `
				+ 'Inkscape files usually mean 96. Check the imported size.',
			);
		}

		return {
			...buildMatrix(viewBox, scaleX, scaleY, offsetX, offsetY, heightMm),
			viewBox,
			physical: { width: widthMm, height: heightMm },
			source: 'width-height+viewBox',
			dpiDependent,
			pixelsPerInch,
			warnings,
		};
	}

	// ---- case 2: a viewBox but no stated size ----------------------------
	if (viewBox !== null) {

		warnings.push(
			'The root <svg> states no width/height; assuming user units are pixels '
			+ `at ${pixelsPerInch} per inch. Check the imported size before cutting.`,
		);

		const physicalHeight = viewBox.height * perPixel;

		return {
			...buildMatrix(viewBox, perPixel, perPixel, 0, 0, physicalHeight),
			viewBox,
			physical: { width: viewBox.width * perPixel, height: physicalHeight },
			source: 'viewBox-only',
			dpiDependent: true,
			pixelsPerInch,
			warnings,
		};
	}

	// ---- case 3: a stated size but no viewBox ----------------------------
	// without a viewBox there is no scaling at all: one user unit is one CSS
	// pixel, and the stated size just says how much of that canvas is visible
	if (widthMm !== null && heightMm !== null) {

		const box = {
			minX: 0,
			minY: 0,
			width: widthMm / perPixel,
			height: heightMm / perPixel,
		};

		const dpiDependent = (width.dpiDependent === true) || (height.dpiDependent === true);

		if (dpiDependent === true) {
			warnings.push(
				'Size is stated without a physical unit, so it depends on an assumed '
				+ `${pixelsPerInch} px/inch. Check the imported size.`,
			);
		}

		return {
			...buildMatrix(box, perPixel, perPixel, 0, 0, heightMm),
			viewBox: box,
			physical: { width: widthMm, height: heightMm },
			source: 'width-height-only',
			dpiDependent,
			pixelsPerInch,
			warnings,
		};
	}

	// ---- case 4: nothing to go on ----------------------------------------
	warnings.push(
		'The root <svg> states neither a size nor a viewBox; assuming pixels at '
		+ `${pixelsPerInch} per inch. The imported size is a guess — verify it before cutting.`,
	);

	return {
		...buildMatrix({ minX: 0, minY: 0, width: 0, height: 0 }, perPixel, perPixel, 0, 0, 0),
		viewBox: null,
		physical: null,
		source: 'assumed',
		dpiDependent: true,
		pixelsPerInch,
		warnings,
	};
}
