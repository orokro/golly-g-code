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
 * @returns {Object} `{ viewport, shapes, source, outward, inward, stats, warnings }`
 */
export function runPipeline(svgText, options = {}) {

	const { toolDiameter = 3.175, tolerance = 0.01 } = options;
	const radius = toolDiameter / 2;

	const startImport = performance.now();
	const { viewport, shapes, warnings } = importSvgDocument(svgText);
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

	// self-intersecting artwork offsets into slivers unless cleaned first
	const startOffset = performance.now();
	const cleaned = closedPolygons.length > 0 ? normalize(closedPolygons, 'nonzero') : [];

	const outward = [
		...(cleaned.length > 0 ? offsetClosed(cleaned, radius) : []),
		// an open path has no inside or outside, so the tool sweep IS its outline
		...(openPolylines.length > 0 ? offsetOpen(openPolylines, radius, { end: OpenEnd.ROUND }) : []),
	];

	const inward = cleaned.length > 0 ? offsetClosed(cleaned, -radius) : [];
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
