/**
 * @file layers.js
 * @description The two layers that show what the machine does BETWEEN the cuts:
 * the holding tabs, and the travel moves.
 *
 * ---------------------------------------------------------------------------
 * Both are derived, neither is recomputed
 *
 * The tab spans come off the toolpath, and the travel comes off the emitted
 * program. Neither is worked out again here, on purpose: a tab drawn in one
 * place and cut in another is worse than a tab that is not drawn at all, and the
 * only way to be sure they agree is for there to be one of them.
 *
 * That is why `tabBands` takes spans rather than tabs, and why `travelSegments`
 * takes the program's own list rather than the toolpaths. The renderer's job
 * here is to turn arc lengths into `d` attributes.
 * ---------------------------------------------------------------------------
 */

import { arcLengths, pointAt, projectOnto } from '@core/cam/tabs.js';

/**
 * The part of a polyline between two arc lengths, with exact ends.
 *
 * @param {Array<Number[]>} points - the polyline
 * @param {Number} from - arc length to start at, millimetres
 * @param {Number} to - arc length to stop at
 * @param {Number[]} [lengths] - precomputed cumulative lengths
 * @returns {Array<Number[]>} the slice, empty when there is nothing between them
 */
export function sliceBetween(points, from, to, lengths = arcLengths(points)) {

	if (points.length < 2 || !(to > from))
		return [];

	const total = lengths[lengths.length - 1];
	const start = Math.max(0, Math.min(from, total));
	const end = Math.max(0, Math.min(to, total));

	if (!(end > start))
		return [];

	const slice = [pointAt(points, start, lengths)];

	for (let i = 0; i < points.length; i++)
		if (lengths[i] > start && lengths[i] < end)
			slice.push(points[i]);

	slice.push(pointAt(points, end, lengths));

	return slice;
}


/**
 * One drawable band per tab, across every job.
 *
 * A tab is drawn at the cutter's full width, like the kerf, because that is the
 * shape of the material it leaves behind — a hairline would say "a tab is here"
 * where the question being asked is "is this bridge wide enough to hold".
 *
 * @param {Array<Object>} toolpaths - what `generateAll` returned
 * @param {Function} widthOf - given a toolpath entry, its cutter diameter
 * @param {Function} [include] - given a job id, whether to draw it at all
 * @returns {Array<Object>} `{ id, jobId, points, width, depth }`
 */
export function tabBands(toolpaths, widthOf, include = () => true) {

	/** @type {Array<Object>} */
	const bands = [];

	for (const entry of toolpaths ?? []) {

		if (!include(entry.jobId))
			continue;

		const width = widthOf(entry);

		(entry.tabSpans ?? []).forEach((spans, run) => {

			const points = entry.paths[run]?.points;

			if (points === undefined)
				return;

			const lengths = arcLengths(points);

			spans.forEach((span, index) => {

				const slice = sliceBetween(points, span.start, span.end, lengths);

				if (slice.length > 1)
					bands.push({
						id: `${entry.jobId}-${run}-${index}`,
						jobId: entry.jobId, points: slice, width, depth: span.depth,
					});
			});
		});
	}

	return bands;
}


/**
 * The travel moves worth drawing, deduplicated.
 *
 * A deep job repeats the same crossing once per pass — six passes over two tabs
 * is twenty-four identical lines stacked on each other, which reads as four and
 * costs six times as much to draw. Only distinct XY crossings are kept, and each
 * carries how many times it happens, so the layer can say "×6" rather than
 * pretending the depth passes are free.
 *
 * @param {Array<Object>} travel - `{ jobId, z, from, to }` from the program
 * @param {Function} [include] - given a job id, whether to draw it
 * @returns {Array<Object>} `{ id, jobId, from, to, times }`
 */
export function travelSegments(travel, include = () => true) {

	/** @type {Map<String, Object>} */
	const seen = new Map();

	for (const move of travel ?? []) {

		if (!include(move.jobId))
			continue;

		const key = `${move.jobId}|${move.from[0]},${move.from[1]}|${move.to[0]},${move.to[1]}`;
		const already = seen.get(key);

		if (already === undefined)
			seen.set(key, { id: key, jobId: move.jobId, from: move.from, to: move.to, times: 1 });
		else
			already.times++;
	}

	return [...seen.values()];
}


/**
 * How far the tool travels without cutting, in millimetres.
 *
 * Counted over every pass rather than over the distinct crossings, because the
 * machine makes all of them. This is the number that changes when you reorder
 * the jobs, and the reason the layer exists.
 *
 * @param {Array<Object>} travel - `{ from, to }` from the program
 * @returns {Number} total distance, millimetres
 */
export function travelDistance(travel) {

	return (travel ?? []).reduce(
		(sum, move) => sum + Math.hypot(move.to[0] - move.from[0], move.to[1] - move.from[1]), 0);
}


/**
 * The draggable handle for each tab, across every job.
 *
 * A handle sits on the ANCHOR, not on the band. Two tabs close enough to share
 * material merge into one span, and a merged span cannot say which tab it came
 * from — so a band is not a thing you can pick up. The anchor is: it is exactly
 * what the tab's `position` means, one per tab node, and it stays distinct right
 * up to the moment two tabs sit on the same millimetre.
 *
 * @param {Array<Object>} toolpaths - what `generateAll` returned
 * @param {Function} [include] - given a job id, whether to draw it
 * @returns {Array<Object>} `{ tabId, jobId, position, point }`
 */
export function tabHandles(toolpaths, include = () => true) {

	/** @type {Array<Object>} */
	const handles = [];

	for (const entry of toolpaths ?? [])
		if (include(entry.jobId))
			for (const anchor of entry.tabAnchors ?? [])
				handles.push({ ...anchor, jobId: entry.jobId });

	return handles;
}


/**
 * Where a point falls along a job's source, as the arc length a tab uses.
 *
 * The source runs are laid end to end into one length, exactly as the tab
 * placement reads them, so the number this returns can be written straight into
 * the field. The nearest run wins — dragging a tab off one outline and onto
 * another is a real thing to want on a job that cuts several shapes, and
 * refusing it would mean deleting the tab and adding another.
 *
 * @param {Array<Object>} sources - the job's source runs, `{ points }`
 * @param {Number[]} point - where the pointer is, in workspace millimetres
 * @returns {Number|null} the position in millimetres, or null with no source
 */
export function positionFromPoint(sources, point) {

	const runs = (sources ?? []).filter((run) => (run.points?.length ?? 0) > 1);

	if (runs.length === 0)
		return null;

	let best = null;
	let offset = Infinity;
	let before = 0;

	for (const run of runs) {

		const lengths = arcLengths(run.points);
		const found = projectOnto(run.points, point, lengths);

		if (found.offset < offset) {
			offset = found.offset;
			best = before + found.distance;
		}

		before += lengths[lengths.length - 1];
	}

	return best;
}
