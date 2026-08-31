/**
 * @file toolpaths.js
 * @description Turning a job in the document into a real toolpath.
 *
 * The seam between the document — which knows what the user asked for — and
 * `core/cam`, which has known how to do it since Phase 1 and has been sitting
 * fully tested with nothing calling it. This file is the wiring, and it is
 * deliberately thin: everything hard already happened in `operations.js` and
 * `openOffset.js`, and anything hard that appears here is a sign something
 * belongs over there instead.
 *
 * ---------------------------------------------------------------------------
 * Closed and open shapes are different problems, in one job
 *
 * A closed contour has an inside and an outside, so `inside`, `outside` and
 * `pocket` all mean something and the tool is offset by its RADIUS to put its
 * edge on the line. An open path has neither, so it gets centre, normal or
 * heading instead (D17, and 1.5's whole argument).
 *
 * A job can hold both. Rather than refuse that, each shape is sent to whichever
 * of the two the operation and its own closedness call for, and a shape the
 * operation cannot apply to is reported rather than silently skipped — a job
 * that emitted three of its four paths and said nothing is the failure mode
 * `no silent failures` exists for.
 * ---------------------------------------------------------------------------
 */

import { flattenSubPaths, DEFAULT_FLATTEN_TOLERANCE } from '../path/flatten.js';
import { union, intersection, difference, xor } from '../geometry/clipper.js';
import { Operation, generateToolpath } from '../cam/operations.js';
import { OpenMode, openToolpath } from '../cam/openOffset.js';
import { NodeType, Combine } from './nodes.js';
import { ancestorOfType, cuttingOrder } from './tree.js';
import { resolvedValues } from './inherit.js';

/** The operations that need a closed contour. */
const CLOSED_OPERATIONS = Object.freeze([Operation.INSIDE, Operation.OUTSIDE, Operation.POCKET]);

/** The operations that only exist for open paths. */
const OPEN_OPERATIONS = Object.freeze([OpenMode.NORMAL, OpenMode.HEADING]);

/** How to combine two sets of contours, by the job's `combine` setting. */
const COMBINERS = Object.freeze({
	[Combine.UNION]: union,
	[Combine.INTERSECT]: intersection,
	[Combine.DIFFERENCE]: difference,
	[Combine.XOR]: xor,
});


/**
 * @typedef {Object} JobToolpath
 * @property {String} jobId - the job this came from
 * @property {String} toolId - the tool it will be cut with
 * @property {Array<Object>} paths - the toolpath, as `{ points, closed }` in
 *   millimetres — the same shape `core/cam` and `core/path` already use for a
 *   run of points, rather than a second convention for the same idea
 * @property {Number[]} depths - the Z of each pass, deepest last
 * @property {Boolean} congruent - whether the toolpath is the source moved
 *   rigidly, which is what tab placement needs to know (see openOffset.js)
 * @property {Array<Object>} source - the flattened source, same shape, for
 *   drawing the line the cut was made from
 * @property {String[]} warnings - anything worth saying about the result
 */


/**
 * Generates the toolpath for one job.
 *
 * @param {Object} project - `{ document, geometry }`
 * @param {String} jobId - the job
 * @param {Object} [options] - options
 * @param {Number} [options.tolerance] - curve flattening tolerance, millimetres
 * @returns {JobToolpath} the result; `paths` is empty when nothing could be cut
 * @throws {TypeError} when the job is not one, or has no tool above it
 */
export function generateJobToolpath(project, jobId, options = {}) {

	const { tolerance = DEFAULT_FLATTEN_TOLERANCE } = options;
	const { document } = project;
	const job = document.nodes[jobId];

	if (job?.type !== NodeType.JOB)
		throw new TypeError(`"${jobId}" is not a job`);

	const tool = ancestorOfType(document, jobId, NodeType.TOOL);

	if (tool === null)
		throw new TypeError(`${job.name} is not inside a tool group, so there is nothing to cut it with`);

	const j = resolvedValues(document, jobId);
	const t = resolvedValues(document, tool.id);

	/** @type {String[]} */
	const warnings = [];

	const runs = gather(project, j.paths, tolerance, warnings);
	const closed = runs.filter((run) => run.closed).map((run) => run.points);
	const open = runs.filter((run) => run.closed === false).map((run) => run.points);

	const empty = {
		jobId, toolId: tool.id, paths: [], depths: [], congruent: true,
		source: runs.map((run) => ({ points: run.points, closed: run.closed })), warnings,
	};

	if (runs.length === 0) {
		warnings.push(`${job.name} has no geometry to cut.`);
		return empty;
	}

	if (!(t.diameter > 0) || !(j.cutDepth > 0))
		return { ...empty, warnings: [...warnings, `${job.name} needs a cut depth and a tool diameter.`] };

	const wantsClosed = CLOSED_OPERATIONS.includes(j.operation);
	const wantsOpen = OPEN_OPERATIONS.includes(j.operation);

	// a shape the operation cannot apply to is REPORTED, not skipped -- a job
	// that emitted three of its four paths and said nothing is the whole reason
	// rule 5 exists
	if (wantsClosed && open.length > 0)
		warnings.push(`${open.length} open path${open.length === 1 ? '' : 's'} cannot be cut`
			+ ` "${j.operation}", which needs a closed contour.`);

	if (wantsOpen && closed.length > 0)
		warnings.push(`${closed.length} closed path${closed.length === 1 ? '' : 's'} cannot be cut`
			+ ` "${j.operation}", which is for open paths.`);

	return wantsOpen
		? openJob({ empty, job, j, t, open, tolerance, warnings })
		: closedJob({ empty, job, j, t, closed, open, warnings });
}


/**
 * Collects a job's source geometry, flattened, one entry per SUBPATH.
 *
 * Per subpath rather than per shape, and using each subpath's OWN closed flag
 * rather than the node's. The node's flag is an aggregate — true only when every
 * subpath is closed — which is the right question for "can this be cut inside"
 * and the wrong one for routing: a shape holding a square and a loose line has
 * a ring worth offsetting and a run worth tracing, and the aggregate says only
 * that it is not entirely closed.
 *
 * The closed runs still travel together into `generateToolpath`, because which
 * contour is a hole is a property of the SET (see import.js).
 *
 * @param {Object} project - the project
 * @param {String[]} pathIds - the job's `paths`
 * @param {Number} tolerance - flattening tolerance
 * @param {String[]} warnings - collected here
 * @returns {Object[]} `{ id, closed, points }` per subpath
 */
function gather(project, pathIds, tolerance, warnings) {

	/** @type {Object[]} */
	const runs = [];

	for (const id of pathIds ?? []) {

		const node = project.document.nodes[id];
		const geometry = project.geometry?.[node?.geometry];

		if (geometry === undefined) {
			warnings.push(`The geometry for "${node?.name ?? id}" is missing.`);
			continue;
		}

		for (const sub of flattenSubPaths(geometry.subPaths, { tolerance }))
			if (sub.points.length > 1)
				runs.push({ id, closed: sub.closed === true, points: sub.points });
	}

	return runs;
}


/**
 * Generates a closed-contour job.
 *
 * @param {Object} context - everything gathered so far
 * @returns {JobToolpath} the result
 */
function closedJob(context) {

	const { empty, job, j, t, closed, open, warnings } = context;

	// `center` and `engrave` follow the line itself, so an open run is welcome
	// in them and is simply another thing to trace
	const contours = j.operation === Operation.CENTER || j.operation === Operation.ENGRAVE
		? [...closed, ...open]
		: closed;

	if (contours.length === 0)
		return { ...empty, warnings };

	const combined = combine(contours, j.combine, warnings);

	const result = generateToolpath(combined, {
		operation: j.operation,
		toolDiameter: t.diameter,
		cutDepth: j.cutDepth,
		passDepth: j.passDepth,
		margin: j.margin,
		width: j.width,
		stepover: j.stepover,
		direction: j.direction,
		topZ: 0,
	});

	return {
		...empty,
		paths: result.paths,
		depths: result.depths,
		congruent: j.operation === Operation.CENTER || j.operation === Operation.ENGRAVE,
		warnings: [...warnings, ...result.warnings.map((w) => `${job.name}: ${w}`)],
	};
}


/**
 * Generates an open-path job.
 *
 * The offset distance is the tool's RADIUS, not its diameter — the cut's EDGE
 * lands on the drawn line, which is what "offset by the tool" means to someone
 * looking at the drawing.
 *
 * @param {Object} context - everything gathered so far
 * @returns {JobToolpath} the result
 */
function openJob(context) {

	const { empty, job, j, t, open, tolerance, warnings } = context;

	if (open.length === 0)
		return { ...empty, warnings };

	/** @type {Array<Array<Number[]>>} */
	const paths = [];

	/** @type {Boolean[]} */
	const congruences = [];

	for (const points of open) {

		const result = openToolpath(points, {
			mode: j.operation,
			distance: t.diameter / 2,
			side: j.offsetSide,
			angleRadians: j.offsetHeading,
			tolerance,
		});

		if (result.path.length > 1)
			paths.push({ points: result.path, closed: false });

		congruences.push(result.congruent);
		warnings.push(...result.warnings.map((w) => `${job.name}: ${w}`));
	}

	return {
		...empty,
		paths,
		depths: depthsFor(j),
		congruent: congruences.every(Boolean),
		warnings,
	};
}


/**
 * Combines a job's contours, when it asks for it.
 *
 * Always an explicit per-job choice, never something the importer does on its
 * own. It matters for real work: three overlapping circles cut separately
 * re-cut air the earlier ones already cleared.
 *
 * @param {Array<Array<Number[]>>} contours - the flattened source contours
 * @param {String} mode - one of {@link Combine}
 * @param {String[]} warnings - collected here
 * @returns {Array<Array<Number[]>>} the contours to offset
 */
function combine(contours, mode, warnings) {

	if (mode === Combine.NONE || mode === undefined)
		return contours;

	const operation = COMBINERS[mode];

	if (operation === undefined) {
		warnings.push(`Unknown combine mode "${mode}"; the paths were left alone.`);
		return contours;
	}

	// the first contour is the subject and the rest are the clip, which is what
	// makes `difference` mean "the first one, minus the others"
	const [first, ...rest] = contours;

	return rest.length === 0 ? contours : operation([first], rest);
}


/**
 * The Z of each pass, for a job whose operation does not compute them itself.
 *
 * @param {Object} j - the job's resolved values
 * @returns {Number[]} descending depths, the last exactly at the target
 */
function depthsFor(j) {

	/** @type {Number[]} */
	const depths = [];

	let z = 0;

	while (z > -j.cutDepth) {
		z = Math.max(z - j.passDepth, -j.cutDepth);
		depths.push(z);
	}

	return depths;
}


/**
 * Generates every job in the project, in cutting order.
 *
 * A job that throws does not stop the others — one misconfigured job should not
 * make the whole preview go blank, and its own entry says what went wrong.
 *
 * @param {Object} project - `{ document, geometry }`
 * @param {Object} [options] - forwarded to {@link generateJobToolpath}
 * @returns {JobToolpath[]} one per job, in the order the machine will cut them
 */
export function generateAll(project, options = {}) {

	return cuttingOrder(project.document).map(({ tool, job }) => {

		try {
			return generateJobToolpath(project, job.id, options);
		}
		catch (error) {
			return {
				jobId: job.id, toolId: tool.id, paths: [], depths: [],
				congruent: true, source: [], warnings: [error.message],
			};
		}
	});
}
