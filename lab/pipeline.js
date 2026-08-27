/**
 * @file pipeline.js
 * @description Runs an SVG through the whole core and reports what happened.
 *
 * Shared by the live lab page and the static snapshot script, so both show
 * exactly the same thing.
 */

import { importSvgDocument, countSubPathKinds } from '../src/core/svg/document.js';
import { flattenSubPath } from '../src/core/path/flatten.js';
import { offsetClosed, offsetOpen, normalize, OpenEnd } from '../src/core/geometry/clipper.js';

/**
 * Imports an SVG and derives toolpath-shaped geometry from it.
 *
 * @param {String} svgText - the raw SVG document
 * @param {Object} [options] - options
 * @param {Number} [options.toolDiameter=3.175] - tool diameter in millimetres (1/8" default)
 * @param {Number} [options.tolerance=0.01] - flattening tolerance in millimetres
 * @param {Number} [options.pixelsPerInch] - resolution for unitless document sizes
 * @returns {Object} `{ viewport, shapes, source, outward, inward, stats, warnings }`
 */
export function runPipeline(svgText, options = {}) {

	const { toolDiameter = 3.175, tolerance = 0.01, pixelsPerInch } = options;
	const radius = toolDiameter / 2;

	const startImport = performance.now();
	const { viewport, shapes, warnings } = importSvgDocument(
		svgText,
		pixelsPerInch === undefined ? {} : { pixelsPerInch },
	);
	const importMs = performance.now() - startImport;

	const startFlatten = performance.now();

	/** @type {Array<Object>} */
	const source = [];

	/** @type {Array<Array<Number[]>>} */
	const closedPolygons = [];

	/** @type {Array<Array<Number[]>>} */
	const openPolylines = [];

	for (const shape of shapes) {
		for (const subPath of shape.subPaths) {

			const flat = flattenSubPath(subPath, { tolerance });

			// A contour that decomposes into more than one path is self-touching:
			// almost always a compound shape written as ONE closed path with a
			// zero-width bridge running out to its hole and back. Illustrator and
			// Inkscape both emit these. It matters because the bridge is a real
			// segment of the path -- harmless for area operations, which resolve it,
			// but an engrave would cut along it and slit the part.
			flat.decomposed = flat.closed && flat.points.length >= 3
				? normalize([flat.points], shape.fillRule)
				: [];
			flat.selfTouching = flat.decomposed.length > 1;

			source.push(flat);

			if (flat.closed)
				closedPolygons.push(flat.points);
			else
				openPolylines.push(flat.points);
		}
	}

	const flattenMs = performance.now() - startFlatten;

	// Offset each shape SEPARATELY.
	//
	// An earlier version normalized every closed path in the document together,
	// which quietly unioned unrelated shapes -- three overlapping circles came out
	// as one blob. normalize() is for resolving self-intersection WITHIN one path,
	// not for merging distinct ones. Combining shapes deliberately is a per-job
	// choice in the app (jscut calls it Combine), never something the importer
	// does behind your back.
	const startOffset = performance.now();

	/** @type {Array<Array<Number[]>>} */
	const outward = [];

	/** @type {Array<Array<Number[]>>} */
	const inward = [];

	for (const polygon of closedPolygons) {
		const cleaned = normalize([polygon], 'nonzero');
		if (cleaned.length === 0)
			continue;
		outward.push(...offsetClosed(cleaned, radius));
		inward.push(...offsetClosed(cleaned, -radius));
	}

	// an open path has no inside or outside, so the tool sweep IS its outline
	for (const polyline of openPolylines)
		outward.push(...offsetOpen([polyline], radius, { end: OpenEnd.ROUND }));

	const offsetMs = performance.now() - startOffset;

	const points = source.reduce((sum, s) => sum + s.points.length, 0);

	// The bounding box of the GEOMETRY, which is not the same thing as the
	// document size and is usually what the user actually cares about: artwork
	// normally sits inside a larger artboard, so "how big is the page" and "how
	// big will this cut" are different questions with different answers.
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

	for (const sub of source) {
		for (const [x, y] of sub.points) {
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}

	const extent = Number.isFinite(minX)
		? { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
		: null;

	return {
		viewport,
		shapes,
		source,
		outward,
		inward,
		warnings,
		extent,
		stats: {
			...countSubPathKinds(shapes),
			selfTouching: source.filter((s) => s.selfTouching === true).length,
			pixelsPerInch: viewport.pixelsPerInch,
			dpiDependent: viewport.dpiDependent,
			shapes: shapes.length,
			points,
			toolDiameter,
			tolerance,
			importMs,
			flattenMs,
			offsetMs,
		},
	};
}
