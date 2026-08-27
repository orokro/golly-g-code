/**
 * @file primitives.js
 * @description Converts every SVG geometry primitive into path data.
 *
 * This module is the direct answer to jscut's most-hit limitation. jscut handles
 * only `<path>` and `<rect>`; everything else produces
 * *"<b>polyline</b> is not supported; try Inkscape's Object to Path command"*.
 * Making the user go re-export their artwork to work around a missing thirty-line
 * converter is not a reasonable thing to do to somebody.
 *
 * Everything here returns an SVG `d` string, so the rest of the pipeline only
 * ever deals with one representation. Curved primitives emit arc (`A`) commands
 * and are converted to cubics downstream by `svgpath.unarc()`, which handles the
 * elliptical maths correctly under non-uniform transforms.
 *
 * Per the SVG spec, a primitive with degenerate geometry (zero or negative size)
 * "disables rendering of the element". Those return `null` rather than emitting a
 * zero-length path that would later become a confusing zero-length toolpath.
 */

/**
 * Reads a numeric attribute, falling back when absent or unparseable.
 *
 * @param {Object} element - a DOM-like element with getAttribute
 * @param {String} name - attribute name
 * @param {Number} [fallback=0] - value to use when absent or invalid
 * @returns {Number} the parsed number, or `fallback`
 */
function num(element, name, fallback = 0) {

	const raw = element.getAttribute(name);
	if (raw === null || raw === undefined || String(raw).trim() === '')
		return fallback;

	const value = Number.parseFloat(raw);
	return Number.isFinite(value) ? value : fallback;
}


/**
 * Parses an SVG `points` list into [x, y] pairs.
 *
 * The grammar allows coordinates separated by whitespace and/or commas, in any
 * combination — `0,0 10,10`, `0 0 10 10` and `0, 0, 10, 10` are all the same
 * list. Per spec, an odd trailing coordinate makes the list an error; we drop it
 * and keep the valid prefix, which is what browsers do.
 *
 * @param {String} raw - the raw `points` attribute value
 * @returns {Array<Array<Number>>} an array of [x, y] pairs, possibly empty
 */
export function parsePoints(raw) {

	if (typeof raw !== 'string')
		return [];

	const numbers = raw
		.trim()
		.split(/[\s,]+/)
		.filter((token) => token !== '')
		.map(Number.parseFloat)
		.filter((value) => Number.isFinite(value));

	const pairs = [];
	for (let i = 0; i + 1 < numbers.length; i += 2)
		pairs.push([numbers[i], numbers[i + 1]]);

	return pairs;
}


/**
 * Builds path data for a `<rect>`, including rounded corners.
 *
 * The rx/ry rules are fiddly and worth stating: if only one is given the other
 * takes its value; each is clamped to half the corresponding side; and a
 * negative value is treated as unspecified.
 *
 * @param {Object} element - the rect element
 * @returns {String|null} path data, or null if the rect does not render
 */
export function rectToPath(element) {

	const x = num(element, 'x');
	const y = num(element, 'y');
	const width = num(element, 'width');
	const height = num(element, 'height');

	// spec: zero or negative width/height disables rendering
	if (width <= 0 || height <= 0)
		return null;

	const rawRx = num(element, 'rx', Number.NaN);
	const rawRy = num(element, 'ry', Number.NaN);

	// a negative radius counts as unspecified; a missing one mirrors the other
	const hasRx = Number.isFinite(rawRx) && rawRx >= 0;
	const hasRy = Number.isFinite(rawRy) && rawRy >= 0;

	let rx = hasRx ? rawRx : (hasRy ? rawRy : 0);
	let ry = hasRy ? rawRy : (hasRx ? rawRx : 0);

	// neither radius may exceed half its side
	rx = Math.min(rx, width / 2);
	ry = Math.min(ry, height / 2);

	if (rx <= 0 || ry <= 0)
		return `M${x} ${y}H${x + width}V${y + height}H${x}Z`;

	return [
		`M${x + rx} ${y}`,
		`H${x + width - rx}`,
		`A${rx} ${ry} 0 0 1 ${x + width} ${y + ry}`,
		`V${y + height - ry}`,
		`A${rx} ${ry} 0 0 1 ${x + width - rx} ${y + height}`,
		`H${x + rx}`,
		`A${rx} ${ry} 0 0 1 ${x} ${y + height - ry}`,
		`V${y + ry}`,
		`A${rx} ${ry} 0 0 1 ${x + rx} ${y}`,
		'Z',
	].join('');
}


/**
 * Builds path data for a `<circle>`.
 *
 * Drawn as two half-arcs rather than four beziers, so the downstream `unarc()`
 * decides the approximation quality instead of baking in a fixed one here.
 *
 * @param {Object} element - the circle element
 * @returns {String|null} path data, or null if the circle does not render
 */
export function circleToPath(element) {

	const r = num(element, 'r');

	// spec: r of zero disables rendering; negative is an error
	if (r <= 0)
		return null;

	return ellipseArcs(num(element, 'cx'), num(element, 'cy'), r, r);
}


/**
 * Builds path data for an `<ellipse>`.
 *
 * @param {Object} element - the ellipse element
 * @returns {String|null} path data, or null if the ellipse does not render
 */
export function ellipseToPath(element) {

	const rx = num(element, 'rx');
	const ry = num(element, 'ry');

	// note: 'auto' radii (which resolve from the other axis) are not supported;
	// they are rare and only meaningful with CSS sizing
	if (rx <= 0 || ry <= 0)
		return null;

	return ellipseArcs(num(element, 'cx'), num(element, 'cy'), rx, ry);
}


/**
 * Emits a closed ellipse as two 180-degree arcs.
 *
 * A single arc cannot express a full ellipse — start and end would coincide and
 * the sweep would be ambiguous — which is why this is split in two.
 *
 * @param {Number} cx - centre x
 * @param {Number} cy - centre y
 * @param {Number} rx - x radius
 * @param {Number} ry - y radius
 * @returns {String} closed path data
 */
function ellipseArcs(cx, cy, rx, ry) {

	return [
		`M${cx - rx} ${cy}`,
		`A${rx} ${ry} 0 0 0 ${cx + rx} ${cy}`,
		`A${rx} ${ry} 0 0 0 ${cx - rx} ${cy}`,
		'Z',
	].join('');
}


/**
 * Builds path data for a `<line>`.
 *
 * Always OPEN. This matters: jscut force-closes every contour, so a line became
 * a degenerate zero-area shape instead of a cut to follow. Open toolpaths are a
 * first-class case here.
 *
 * @param {Object} element - the line element
 * @returns {String|null} path data, or null if the line has no length
 */
export function lineToPath(element) {

	const x1 = num(element, 'x1');
	const y1 = num(element, 'y1');
	const x2 = num(element, 'x2');
	const y2 = num(element, 'y2');

	if (x1 === x2 && y1 === y2)
		return null;

	return `M${x1} ${y1}L${x2} ${y2}`;
}


/**
 * Builds path data for a `<polyline>` — the primitive jscut chokes on.
 *
 * Left OPEN, unlike `<polygon>`.
 *
 * @param {Object} element - the polyline element
 * @returns {String|null} path data, or null if there are too few points
 */
export function polylineToPath(element) {

	return pointsToPath(element.getAttribute('points'), false);
}


/**
 * Builds path data for a `<polygon>`.
 *
 * Implicitly CLOSED, per spec.
 *
 * @param {Object} element - the polygon element
 * @returns {String|null} path data, or null if there are too few points
 */
export function polygonToPath(element) {

	return pointsToPath(element.getAttribute('points'), true);
}


/**
 * Shared implementation for polyline and polygon.
 *
 * @param {String} raw - the raw `points` attribute
 * @param {Boolean} close - whether to append a Z
 * @returns {String|null} path data, or null if fewer than two points
 */
function pointsToPath(raw, close) {

	const points = parsePoints(raw);
	if (points.length < 2)
		return null;

	const [first, ...rest] = points;
	const body = rest.map(([x, y]) => `L${x} ${y}`).join('');

	return `M${first[0]} ${first[1]}${body}${close ? 'Z' : ''}`;
}


/**
 * The set of element names this module can convert.
 *
 * `path` is included because callers dispatch on it too, even though its data is
 * read straight off the `d` attribute.
 *
 * @readonly
 */
export const SUPPORTED_PRIMITIVES = Object.freeze([
	'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
]);


/**
 * Converts any supported SVG geometry element into path data.
 *
 * @param {Object} element - a DOM-like element with `nodeName` and `getAttribute`
 * @returns {String|null} path data, or null when the element does not render
 * @throws {TypeError} when the element is not a supported geometry primitive
 */
export function elementToPathData(element) {

	// strip any namespace prefix (svg:rect) and normalise case
	const tag = String(element.nodeName || '').replace(/^.*:/, '').toLowerCase();

	switch (tag) {

		case 'path': {
			const d = element.getAttribute('d');
			return (typeof d === 'string' && d.trim() !== '') ? d : null;
		}

		case 'rect': return rectToPath(element);
		case 'circle': return circleToPath(element);
		case 'ellipse': return ellipseToPath(element);
		case 'line': return lineToPath(element);
		case 'polyline': return polylineToPath(element);
		case 'polygon': return polygonToPath(element);

		default:
			throw new TypeError(`Not a geometry primitive: <${tag}>`);
	}
}
