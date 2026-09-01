/**
 * @file diagnostics.js
 * @description What the program has to say about a project before it is cut.
 *
 * ---------------------------------------------------------------------------
 * The rule this file lives by
 *
 * D17: the kerf IS the artwork. Greg is not freeing a part; he is cutting a
 * groove that follows a line he drew. So detail finer than the bit, a cut that
 * does not reach through, a job with no tabs — none of those are mistakes, and
 * a program that flags them is a program you learn to ignore.
 *
 * The split is therefore not "good" and "bad". It is:
 *
 *   INFO     a fact about what will happen. Always shown, never coloured like a
 *            problem. "Cuts 1.0mm of 4.0mm — 3.0mm left." This is the whole
 *            mechanism for noticing that changing the stock changed what the
 *            jobs do: twelve jobs that said "through" now say "3.0mm left", and
 *            nothing had to shout.
 *   WARNING  probably not what you meant, and the machine will still do it.
 *   ERROR    the toolpath cannot be generated, or would be wrong. Blocks export.
 *
 * Cut depth is an explicit number and nothing here recalculates it. Greg's call,
 * and the right one: a depth that moves when the stock does is a depth you
 * cannot trust, and the failure mode of a number that silently changed under you
 * is far worse than the failure mode of a number you have to retype.
 *
 * Things this deliberately does NOT report:
 *   - a job with no tabs. Both halves may be clamped; "is the part held" is the
 *     wrong question when nothing is being cut free (D17)
 *   - detail smaller than the tool. That is what the kerf preview is for
 *   - a pass depth larger than the cut depth. That is one pass, which is fine
 * ---------------------------------------------------------------------------
 */

import { NodeType } from './nodes.js';
import { Operation } from '../cam/operations.js';
import { OpenMode } from '../cam/openOffset.js';
import { parentIndex, childrenOf, cuttingOrder, folderOf } from './tree.js';
import { resolvedValues } from './inherit.js';
import { outlineOf } from './jobs.js';

/** How much attention a diagnostic deserves. */
export const Level = Object.freeze({
	INFO: 'info',
	WARNING: 'warning',
	ERROR: 'error',
});

/** What a cut does to the stock. Descriptive, never a judgement. */
export const DepthClass = Object.freeze({
	GROOVE: 'groove',
	THROUGH: 'through',
	BEYOND: 'beyond',
});

/**
 * Slop for depth comparisons, millimetres.
 *
 * Chosen against machine resolution rather than float precision, per rule 6 in
 * CONVENTIONS.md: a hobby router does not resolve 0.001mm, so a cut depth within
 * that of the stock thickness IS the stock thickness.
 */
export const DEPTH_EPSILON = 0.001;

/** Operations that need a closed path to mean anything. */
export const CLOSED_ONLY = Object.freeze([Operation.INSIDE, Operation.OUTSIDE, Operation.POCKET]);

/** Operations that only exist because an open path has no inside or outside. */
export const OPEN_ONLY = Object.freeze([OpenMode.NORMAL, OpenMode.HEADING]);


/**
 * @typedef {Object} Diagnostic
 * @property {String} nodeId - what it is about, so the outliner can badge it
 * @property {String} level - one of {@link Level}
 * @property {String} code - stable identifier, for tests and for filtering
 * @property {String} message - what to show the user
 * @property {Object} [data] - the numbers behind the sentence, for a caller that
 *   needs to say the same thing differently. The outliner does: a job row is
 *   170 pixels wide and the full sentence does not fit in it, so it renders a
 *   compact form of the same fact and keeps the sentence as the tooltip.
 *   Reformatting a string would be parsing our own prose
 */


/**
 * How a cut depth relates to the stock.
 *
 * @param {Number} cutDepth - the job's depth, millimetres from the surface
 * @param {Number} thickness - the material thickness
 * @param {Number} allowance - how far past the bottom a through cut may go
 * @returns {Object} `{ depthClass, remaining, past }` — millimetres left below
 *   the cut, and millimetres past the allowance
 */
export function classifyDepth(cutDepth, thickness, allowance) {

	const remaining = thickness - cutDepth;
	const past = cutDepth - (thickness + allowance);

	if (remaining > DEPTH_EPSILON)
		return { depthClass: DepthClass.GROOVE, remaining, past };

	if (past > DEPTH_EPSILON)
		return { depthClass: DepthClass.BEYOND, remaining, past };

	return { depthClass: DepthClass.THROUGH, remaining, past };
}


/**
 * Rounds for a message, so a diagnostic never reads "2.9999999999999996mm".
 *
 * @param {Number} value - millimetres
 * @returns {String} two decimals, trailing zeros kept for a steady column
 */
function mm(value) {
	return `${value.toFixed(2)}mm`;
}


/**
 * Everything worth saying about a project.
 *
 * @param {Object} project - `{ document, geometry }`
 * @returns {Diagnostic[]} in document order, most severe first within a node
 */
export function diagnose(project) {

	const { document } = project;
	const index = parentIndex(document);
	const root = document.nodes[document.root];

	/** @type {Diagnostic[]} */
	const found = [];

	/**
	 * Records one.
	 *
	 * @param {String} nodeId - what it is about
	 * @param {String} level - one of {@link Level}
	 * @param {String} code - stable identifier
	 * @param {String} message - what to show
	 * @param {Object} [data] - the numbers behind it
	 */
	const say = (nodeId, level, code, message, data) => found.push(
		data === undefined ? { nodeId, level, code, message } : { nodeId, level, code, message, data });

	if (root === undefined)
		return [{ nodeId: document.root, level: Level.ERROR, code: 'no-project', message: 'The document has no project node.' }];

	const project_ = resolvedValues(document, root.id, index);

	if (!(project_.safeZ > 0))
		say(root.id, Level.ERROR, 'safe-z',
			'Safe Z must be above the material surface, which is zero.');

	for (const { tool, job } of cuttingOrder(document)) {

		const t = resolvedValues(document, tool.id, index);
		const j = resolvedValues(document, job.id, index);

		if (!(t.diameter > 0))
			say(tool.id, Level.ERROR, 'tool-diameter',
				`${tool.name} has no cutting diameter, so there is no kerf to draw or cut.`);

		if (!(t.stepover > 0) || t.stepover > 1)
			say(tool.id, Level.ERROR, 'tool-stepover',
				`${tool.name}'s stepover must be more than 0 and at most 1.`);

		if (outlineOf(project, job.id).total === 0)
			say(job.id, Level.ERROR, 'job-empty',
				`${job.name} has no outline, so there is nothing to cut.`);

		if (!(j.cutDepth > 0))
			say(job.id, Level.ERROR, 'job-depth',
				`${job.name} has no cut depth.`);
		else {

			describeDepth(say, job, j, project_);

			// The tool has to reach from safe Z down to the bottom of the cut, so
			// that span has to fit inside the machine's Z travel. True wherever
			// the work zero is set, because it is the SPAN and not the position.
			const span = project_.safeZ + j.cutDepth;

			if (span > project_.zTravel + DEPTH_EPSILON)
				say(job.id, Level.ERROR, 'z-travel',
					`${job.name} needs ${mm(span)} of Z travel — ${mm(project_.safeZ)} of`
					+ ` safe Z plus ${mm(j.cutDepth)} of cut — and the machine has`
					+ ` ${mm(project_.zTravel)}.`);
		}

		checkOperation(say, project, job, j);

		for (const tab of childrenOf(document, job.id)) {

			if (tab.type !== NodeType.TAB)
				continue;

			const b = resolvedValues(document, tab.id, index);

			if (b.depth >= j.cutDepth - DEPTH_EPSILON)
				say(tab.id, Level.WARNING, 'tab-no-effect',
					`${tab.name} is cut to ${mm(b.depth)}, as deep as the cut itself,`
					+ ' so it breaks nothing.');

			if (!(b.length > 0))
				say(tab.id, Level.WARNING, 'tab-length',
					`${tab.name} has no length.`);
		}

		checkTabOverlaps(say, document, job, index);
	}

	for (const tool of toolsOf(document))
		if (childrenOf(document, tool.id).length === 0)
			say(tool.id, Level.INFO, 'tool-empty',
				`${tool.name} has no jobs, so it emits nothing.`);

	return found;
}


/**
 * Says what a job's depth does to the stock.
 *
 * Groove and through are INFO on purpose. A groove is not a mistake — it is most
 * of what this program is for — and stating it plainly is what makes a change of
 * material visible without anything having to complain.
 *
 * @param {Function} say - records a diagnostic
 * @param {Object} job - the job node
 * @param {Object} j - the job's resolved values
 * @param {Object} p - the project's resolved values
 */
function describeDepth(say, job, j, p) {

	const { depthClass, remaining, past } = classifyDepth(
		j.cutDepth, p.materialThickness, p.cutThroughAllowance);

	const data = {
		depthClass,
		remaining,
		past,
		cutDepth: j.cutDepth,
		thickness: p.materialThickness,
		into: j.cutDepth - p.materialThickness,
	};

	if (depthClass === DepthClass.GROOVE)
		say(job.id, Level.INFO, 'depth-groove',
			`Cuts ${mm(j.cutDepth)} of ${mm(p.materialThickness)} — ${mm(remaining)} left below.`, data);

	else if (depthClass === DepthClass.THROUGH)
		say(job.id, Level.INFO, 'depth-through',
			`Cuts through ${mm(p.materialThickness)} and ${mm(data.into)}`
			+ ' into the spoilboard.', data);

	else
		say(job.id, Level.WARNING, 'depth-beyond',
			`Cuts ${mm(past)} deeper into the spoilboard than the ${mm(p.cutThroughAllowance)}`
			+ ' allowance. Check the material thickness.', data);
}


/**
 * Checks that a job's operation means anything for the paths it cuts.
 *
 * An open path has no inside or outside, so `pocket` on one is not a preference
 * the program can honour. Meaningless for EVERY path is an error; meaningless
 * for some of a mixed selection is a warning, because the rest will still cut.
 *
 * @param {Function} say - records a diagnostic
 * @param {Object} project - `{ document, geometry }`, for the job's own outline
 * @param {Object} job - the job node
 * @param {Object} j - the job's resolved values
 */
function checkOperation(say, project, job, j) {

	// Counted from the SUBPATHS of the job's own outline, not from a stored flag
	// on the path it came from. The flag is an aggregate — true only when every
	// subpath is closed — so a shape holding a square and a loose line reported
	// "not closed" while having a perfectly good ring in it to cut round.
	const outline = outlineOf(project, job.id);

	if (outline.total === 0)
		return;

	const closedOnly = CLOSED_ONLY.includes(j.operation);
	const openOnly = OPEN_ONLY.includes(j.operation);

	if (closedOnly === false && openOnly === false)
		return;

	const wrong = closedOnly ? outline.open : outline.closed;

	if (wrong === 0)
		return;

	const need = closedOnly ? 'closed' : 'open';
	const level = wrong === outline.total ? Level.ERROR : Level.WARNING;
	const which = wrong === outline.total
		? `its ${outline.total === 1 ? 'outline is' : 'outlines are'} not`
		: `${wrong} of its ${outline.total} outlines are not`;

	say(job.id, level, 'operation-mismatch',
		`${job.name} is set to "${j.operation}", which needs a ${need} path, but ${which}.`);
}


/**
 * Warns when two tabs on the same job overlap.
 *
 * Two overlapping breaks are one longer break, which is not what either of them
 * says it is — and since tabs are placed by hand and dragged along the path,
 * running one into its neighbour is easy to do and hard to see.
 *
 * @param {Function} say - records a diagnostic
 * @param {Object} document - the project document
 * @param {Object} job - the job node
 * @param {Map<String, String>} index - the parent index
 */
function checkTabOverlaps(say, document, job, index) {

	const tabs = childrenOf(document, job.id)
		.filter((tab) => tab.type === NodeType.TAB)
		.map((tab) => ({ tab, ...resolvedValues(document, tab.id, index) }))
		.sort((a, b) => a.position - b.position);

	for (let i = 1; i < tabs.length; i += 1) {

		const previous = tabs[i - 1];
		const current = tabs[i];

		if (previous.position + (previous.length / 2) > current.position - (current.length / 2))
			say(current.tab.id, Level.WARNING, 'tab-overlap',
				`${current.tab.name} overlaps ${previous.tab.name}, so they make one longer break.`);
	}
}


/**
 * Every tool group in the project.
 *
 * @param {Object} document - the project document
 * @returns {Object[]} the Tool nodes
 */
function toolsOf(document) {

	const jobs = folderOf(document, 'jobs');

	return jobs === null ? [] : childrenOf(document, jobs.id).filter((n) => n.type === NodeType.TOOL);
}


/**
 * Whether anything found would stop a program being emitted.
 *
 * The staleness contract in 5.4 blocks Export on this, and on nothing softer —
 * a warning is the user's business.
 *
 * @param {Diagnostic[]} diagnostics - what {@link diagnose} returned
 * @returns {Boolean} true when at least one is an error
 */
export function blocksExport(diagnostics) {
	return diagnostics.some((d) => d.level === Level.ERROR);
}


/**
 * Groups diagnostics by the node they are about.
 *
 * What the outliner badges from.
 *
 * @param {Diagnostic[]} diagnostics - what {@link diagnose} returned
 * @returns {Map<String, Diagnostic[]>} by node id
 */
export function byNode(diagnostics) {

	/** @type {Map<String, Diagnostic[]>} */
	const grouped = new Map();

	for (const diagnostic of diagnostics)
		grouped.set(diagnostic.nodeId, [...(grouped.get(diagnostic.nodeId) ?? []), diagnostic]);

	return grouped;
}
