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

	return {
		viewport,
		shapes,
		source,
		outward,
		inward,
		warnings,
		stats: {
			...countSubPathKinds(shapes),
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
