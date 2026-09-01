/**
 * @file jobs.js
 * @description Making a job from artwork.
 *
 * ---------------------------------------------------------------------------
 * A job owns its outline
 *
 * Greg's call, and it is the whole shape of this file: *"The SVG is for
 * importing shapes, the jobs are the first class objects."*
 *
 * So `Create job from path` COPIES the outline into the job rather than
 * referencing it. The job then has its own geometry and its own placement, and
 * everything that follows from that is the point of the decision: hide the
 * drawing and the job is still there; delete the drawing and the job still cuts;
 * re-import the file at another resolution and the job does not move; move the
 * drawing and the job stays where you put it.
 *
 * The cost, stated plainly: fixing the artwork no longer fixes the job. The
 * `source` field records which paths a job came from so that an explicit "update
 * from source" has something to aim at, but nothing reads it to cut with. A
 * record, not a link.
 *
 * ## "It should appear exactly where the path was"
 *
 * The copy is verbatim — the same subpaths, arcs still arcs. What moves across
 * is the path's PLACEMENT, decomposed out of its composed matrix and written
 * into the job's own three fields.
 *
 * Baking the matrix into the points would have been the other way to do it, and
 * it is worse for one specific reason: an arc under a non-uniform scale is an
 * ellipse, which the geometry format cannot hold, so baking would mean
 * flattening every curve at whatever tolerance happened to apply that day. The
 * decomposition is exact for everything `localMatrix` can build.
 * ---------------------------------------------------------------------------
 */

import { NodeType, createNode } from './nodes.js';
import { matrixFor, decompose, centreOf, IDENTITY } from './placement.js';

/** What a job made from nothing is called. */
const UNTITLED = 'Job';


/**
 * @typedef {Object} PreparedJob
 * @property {Object} job - the job node, not yet in the document
 * @property {Object} geometry - `{ [id]: { subPaths } }` to merge into the store
 * @property {String[]} warnings - anything worth saying
 */


/**
 * Builds a job that owns a copy of the given paths' outlines.
 *
 * @param {Object} project - `{ document, geometry }`
 * @param {String[]} pathIds - the SvgPath nodes to copy from
 * @param {Object} [options] - options
 * @param {Function} [options.newId] - id factory
 * @param {String} [options.name] - the job's name; derived from the paths if absent
 * @param {Object} [options.fields] - extra fields for the job node
 * @returns {PreparedJob} the job and the geometry it owns
 */
export function prepareJob(project, pathIds, options = {}) {

	const { newId, name, fields = {} } = options;
	const { document } = project;

	/** @type {String[]} */
	const warnings = [];

	const sources = (pathIds ?? [])
		.map((id) => document.nodes[id])
		.filter((node) => node?.type === NodeType.SVG_PATH);

	/** @type {Object[]} every subpath from every source, in order */
	const subPaths = [];

	for (const node of sources) {

		const found = project.geometry?.[node.geometry];

		if (found === undefined) {
			warnings.push(`"${node.name}" has no geometry, so nothing was copied from it.`);
			continue;
		}

		subPaths.push(...cloneSubPaths(found.subPaths ?? []));
	}

	// Every source is placed independently, so taking on ONE of their placements
	// is only meaningful when they agree. They do in the case that matters -- the
	// paths of one drawing, none of them moved -- and when they disagree the
	// honest thing is to keep the copy where it already is rather than pick a
	// winner and move the others.
	const placement = placementFrom(project, sources, warnings);

	const geometryId = newId === undefined ? `g-${subPaths.length}-${Date.now()}` : newId();

	const job = createNode(NodeType.JOB, {
		name: name ?? nameFor(sources),
		geometry: geometryId,
		source: sources.map((node) => node.id),
		...placement,
		...fields,
	}, { newId });

	return { job, geometry: { [geometryId]: { subPaths } }, warnings };
}


/**
 * The placement a new job takes on from the paths it was copied from.
 *
 * @param {Object} project - the project
 * @param {Object[]} sources - the source path nodes
 * @param {String[]} warnings - collected here
 * @returns {Object} `{ offset, rotation, scale }`, or nothing to inherit defaults
 */
function placementFrom(project, sources, warnings) {

	if (sources.length === 0)
		return {};

	const matrices = sources.map((node) => matrixFor(project, node.id));
	const agree = matrices.every((m) => m.every((value, i) => Math.abs(value - matrices[0][i]) < 1e-9));

	if (!agree) {
		warnings.push('The paths are placed differently from each other, so the job was left'
			+ ' where they are rather than taking on one of their positions.');
		return {};
	}

	if (matrices[0].every((value, i) => value === IDENTITY[i]))
		return {};

	// the copied geometry has the same shape as the source, so it has the same
	// centre, and the decomposition can be expressed about that same point
	return decompose(matrices[0], centreOf(project, sources[0].id));
}


/**
 * A deep copy of a set of subpaths.
 *
 * By hand, because `structuredClone` throws `DataCloneError` on a Proxy and the
 * document may well be one. Same reason `snapshot.js` has its own.
 *
 * @param {Object[]} subPaths - the subpaths to copy
 * @returns {Object[]} a copy sharing nothing with the original
 */
function cloneSubPaths(subPaths) {

	return subPaths.map((sub) => ({
		...sub,
		start: sub.start === undefined ? undefined : [...sub.start],
		segments: (sub.segments ?? []).map((segment) => ({
			...segment,
			to: segment.to === undefined ? undefined : [...segment.to],
			c1: segment.c1 === undefined ? undefined : [...segment.c1],
			c2: segment.c2 === undefined ? undefined : [...segment.c2],
			centre: segment.centre === undefined ? undefined : [...segment.centre],
		})),
	}));
}


/**
 * What to call a job made from these paths.
 *
 * @param {Object[]} sources - the source nodes
 * @returns {String} the name
 */
function nameFor(sources) {

	if (sources.length === 0)
		return UNTITLED;

	return sources.length === 1 ? sources[0].name : `${sources.length} paths`;
}


/**
 * Whether a job's own outline is closed, and how much of it.
 *
 * Read from the geometry the job owns rather than from a stored flag, because
 * the flag was the thing that could disagree with the shape.
 *
 * @param {Object} project - `{ document, geometry }`
 * @param {String} jobId - the job
 * @returns {Object} `{ total, closed, open }` counts of subpaths
 */
export function outlineOf(project, jobId) {

	const node = project.document.nodes[jobId];
	const subPaths = project.geometry?.[node?.geometry]?.subPaths ?? [];

	const closed = subPaths.filter((sub) => sub.closed === true).length;

	return { total: subPaths.length, closed, open: subPaths.length - closed };
}
