/**
 * @file program.js
 * @description The seam between the document and `core/post` — everything a
 * user set up turned into one G-code program.
 *
 * `toolpaths.js` answers "where does the cutter go, in XY". This file answers
 * everything else the machine needs to be told: how deep, how many passes, where
 * the breaks for the holding tabs fall, how the cutter gets into the cut and out
 * of it, which bit is fitted, how fast, and in what order. `core/post` then
 * words it for a particular controller.
 *
 * Nothing here decides geometry. If something in this file starts computing
 * offsets or fitting curves, it belongs in `cam` and this file should be calling
 * it instead — the same rule `toolpaths.js` was written under, for the same
 * reason.
 *
 * ---------------------------------------------------------------------------
 * Three things worth stating outright, because they are choices
 *
 * **Coordinates are rebased on the work zero.** The document holds everything in
 * workspace millimetres, and the puck says where the machine's 0,0 sits on that
 * workspace. The G-code is written in the machine's frame, so the puck is
 * subtracted from every emitted point. Move the puck, and the same part cuts
 * somewhere else on the bed without a single path changing.
 *
 * **Hidden is not disabled.** `visible` hides a node in the workspace; it does
 * not excuse it from being cut. A job you can no longer see is still a job, and
 * quietly dropping it from the program is exactly the silent failure the
 * conventions forbid. Delete it, or move it out of `Jobs\`.
 *
 * **A tab finds its own toolpath.** Tabs are anchored to the source (see
 * `cam/tabs.js` for the whole argument), and a job can hold several source runs
 * and produce several toolpath runs that do not correspond one to one — a pocket
 * makes many rings from one outline. So each tab is placed on the toolpath run
 * that actually passes closest to it, which is the right answer for the case
 * that matters (one outline, one contour) and a defensible one everywhere else.
 * ---------------------------------------------------------------------------
 */

import { emitProgram } from '../post/program.js';
import { planPass } from '../cam/tabs.js';
import { leadIn, leadOut } from '../cam/entry.js';
import { cuttingOrder } from './tree.js';
import { resolvedValues } from './inherit.js';
import { generateAll } from './toolpaths.js';
import { diagnose, blocksExport, Level } from './diagnostics.js';

/**
 * How much of a turn a lead-in sweeps through.
 *
 * A quarter turn is the usual choice: enough that the cutter is travelling along
 * the finished edge before it touches it, not so much that the lead needs a bay
 * of clear scrap to swing through.
 *
 * @type {Number}
 */
export const LEAD_SWEEP = Math.PI / 2;

/** Z of the material surface. Everything in the document is measured from it. */
const TOP_Z = 0;


/**
 * @typedef {Object} ProgramResult
 * @property {String} text - the whole program, newline separated
 * @property {String[]} lines - the same program, a line at a time
 * @property {String[]} warnings - everything worth saying about it
 * @property {Object|null} stats - move counts from the emitter, null when blocked
 * @property {Array<Object>} blocks - `{ jobId, name, from, to }` line ranges,
 *   inclusive and zero based, for mapping the editor back to the outliner
 * @property {Array<Object>} blocked - the error diagnostics that stopped it,
 *   empty when a program was produced
 * @property {Array<Object>} travel - `{ jobId, z, from, to }` per rapid across
 *   the work, in WORKSPACE millimetres so the view can draw them directly
 */


/**
 * Builds the plan for the whole project, ready for the emitter.
 *
 * Separate from {@link generateProgram} because the plan is the interesting
 * half: it is what a test can measure without going through a dialect, and what
 * a second dialect would be handed unchanged.
 *
 * @param {Object} project - `{ document, geometry }`
 * @param {Object} [options] - options
 * @param {Array<Object>} [options.toolpaths] - the result of `generateAll`, when
 *   the caller already has it. Regenerated here when absent
 * @param {Number} [options.tolerance] - flattening tolerance, forwarded
 * @param {String} [options.name] - the program name, for the header comment
 * @returns {Object} `{ plan, warnings }`
 */
export function buildPlan(project, options = {}) {

	const { document } = project;
	const p = resolvedValues(document, document.root);
	const generated = options.toolpaths ?? generateAll(project, options);
	const byJob = new Map(generated.map((entry) => [entry.jobId, entry]));

	/** @type {String[]} */
	const warnings = [];

	/** @type {Array<Object>} */
	const jobs = [];

	/** @type {Array<Object>} the rapids between cuts, in workspace millimetres */
	const travel = [];

	/**
	 * Where the tool was left by the previous cut, carried ACROSS jobs.
	 *
	 * Resetting this per job dropped the rapid from the end of one job to the
	 * start of the next — which is the longest travel in most programs and the
	 * one that actually changes when you reorder the jobs, so a layer without it
	 * answers the question it exists to answer with a blank.
	 */
	let at = null;

	/** @type {Map<String, Number>} tool node id to the T number it gets */
	const numbers = new Map();

	const zero = p.workZero ?? { x: 0, y: 0 };

	for (const { tool, job } of cuttingOrder(document)) {

		if (!numbers.has(tool.id))
			numbers.set(tool.id, numbers.size + 1);

		const toolpath = byJob.get(job.id);

		if (toolpath === undefined) {
			warnings.push(`${job.name} produced no toolpath at all, which should not happen.`);
			continue;
		}

		warnings.push(...toolpath.warnings);

		// nothing to cut is already explained by whoever decided it; adding a
		// second sentence here would just say it twice
		if (toolpath.paths.length === 0 || toolpath.depths.length === 0)
			continue;

		const j = resolvedValues(document, job.id);
		const t = resolvedValues(document, tool.id);

		if (j.dogbones)
			warnings.push(`${job.name}: dogbones are switched on, but nothing implements them yet,`
				+ ' so the inside corners were left square.');

		const passes = toolpath.depths.map((z) => ({
			z,
			runs: cutsForPass(toolpath.paths, toolpath.tabSpans, z, j),
		}));

		// The travel is recorded in WORKSPACE coordinates, before the work zero is
		// taken off, because the workspace is where it gets drawn. Derived from the
		// runs the emitter will actually be handed rather than re-deriving the
		// "up, across, down between every run" rule in the renderer -- two copies
		// of an ordering rule is two copies that drift.
		at = travelBetween(passes, job.id, at, travel);

		for (const pass of passes)
			pass.runs = pass.runs.map((run) => ({
				points: run.points.map(([x, y]) => [x - zero.x, y - zero.y]),
			}));

		jobs.push({
			id: job.id,
			name: job.name,
			tool: { number: numbers.get(tool.id), diameter: t.diameter, rpm: j.spindleRpm },
			feeds: { cut: j.cutFeed, plunge: j.plungeRate },
			// `ramp` present-and-null means plunge THIS job while others ramp,
			// which is what a per-job boolean has to be able to say
			ramp: j.ramp ? { angleRadians: j.rampAngle } : null,
			passes,
		});
	}

	const plan = {
		safeZ: p.safeZ,
		topZ: TOP_Z,
		program: { name: options.name ?? document.nodes[document.root]?.name ?? 'GollyGCode' },
		jobs,
	};

	return { plan, warnings, travel };
}


/**
 * Generates the whole program.
 *
 * Refuses to produce anything at all when a diagnostic says the project cannot
 * be cut. Half a program is worse than none: it looks like a file, it loads into
 * a sender, and the part it quietly left out is the part you find out about with
 * a spindle in your hand.
 *
 * @param {Object} project - `{ document, geometry }`
 * @param {Object} [options] - as {@link buildPlan}, plus
 * @param {Object} [options.dialect] - the post-processor dialect
 * @param {Number} [options.arcTolerance] - refit runs as G2/G3 within this
 *   deviation in millimetres. Omit for straight moves only
 * @param {Array<Object>} [options.diagnostics] - the result of `diagnose`, when
 *   the caller already has it
 * @returns {ProgramResult} the program, or what stopped it
 */
export function generateProgram(project, options = {}) {

	const found = options.diagnostics ?? diagnose(project);
	const blocked = found.filter((d) => d.level === Level.ERROR);

	if (blocksExport(found))
		return {
			text: '', lines: [], stats: null, blocks: [], blocked, travel: [],
			warnings: blocked.map((d) => d.message),
		};

	const { plan, warnings, travel } = buildPlan(project, options);
	const p = resolvedValues(project.document, project.document.root);

	const { lines, warnings: emitted, stats } = emitProgram(plan, {
		dialect: options.dialect,
		spindleDwell: p.spindleDwell,
		arcTolerance: options.arcTolerance,
	});

	return {
		text: `${lines.join('\n')}\n`,
		lines,
		warnings: [...warnings, ...emitted],
		stats,
		blocks: mapBlocks(lines),
		blocked: [],
		travel,
	};
}


/**
 * The line range each job occupies, from the breadcrumbs it left.
 *
 * Read back out of the emitted text rather than counted while emitting, so the
 * map cannot drift from the file: if the breadcrumbs are wrong the map is wrong
 * in the same way, and that is visible.
 *
 * @param {String[]} lines - the emitted program
 * @returns {Array<Object>} `{ jobId, name, from, to }`, inclusive, zero based
 */
export function mapBlocks(lines) {

	/** @type {Array<Object>} */
	const blocks = [];

	let open = null;

	lines.forEach((line, index) => {

		const start = /^;<job name="([^"]*)"(?: id="([^"]*)")?>$/.exec(line);

		if (start !== null) {
			open = { jobId: start[2] ?? null, name: start[1], from: index, to: index };
			return;
		}

		if (line === ';</job>' && open !== null) {
			blocks.push({ ...open, to: index });
			open = null;
		}
	});

	return blocks;
}


/**
 * The runs actually cut on one depth pass, across all of a job's contours.
 *
 * @param {Array<Object>} paths - the job's toolpath runs
 * @param {Array<Array<Object>>} spans - the tab spans, one array per run
 * @param {Number} z - the depth of this pass
 * @param {Object} j - the job's resolved values
 * @returns {Array<Object>} `{ points }` in travel order, in workspace millimetres
 */
function cutsForPass(paths, spans, z, j) {

	/** @type {Array<Object>} */
	const runs = [];

	paths.forEach((path, index) => {
		for (const cut of withLeads(planPass(path.points, spans?.[index] ?? [], z, { topZ: TOP_Z }), j))
			runs.push({ points: cut });
	});

	return runs;
}


/**
 * The rapids between one cut and the next.
 *
 * Every gap between two runs is the same three moves — up to safe Z, across,
 * back down — so what is worth drawing is the ACROSS: the straight line in XY
 * from where one cut stopped to where the next one starts. That line is the
 * whole reason the layer exists. Reorder the jobs and it moves; that is what
 * Greg wanted to be able to see rather than argue about.
 *
 * @param {Array<Object>} passes - the job's passes, in workspace coordinates
 * @param {String} jobId - the job they belong to, so the layer can be filtered
 * @param {Number[]|null} from - where the previous job left the tool
 * @param {Array<Object>} moves - collected here, as `{ jobId, z, from, to }`
 * @returns {Number[]|null} where this job leaves the tool
 */
function travelBetween(passes, jobId, from, moves) {

	/** @type {Number[]|null} where the previous cut ended */
	let at = from;

	for (const pass of passes)
		for (const run of pass.runs) {

			const points = run.points;

			if (points.length < 2)
				continue;

			if (at !== null && (at[0] !== points[0][0] || at[1] !== points[0][1]))
				moves.push({ jobId, z: pass.z, from: at, to: points[0] });

			at = points[points.length - 1];
		}

	return at;
}


/**
 * Adds the lead-in and lead-out, when the job asks for them.
 *
 * Only to the first and last run of a contour. A tab is a break in the middle of
 * a cut the tool is already committed to; swinging out and back in around every
 * one of them would put an arc into the scrap at each tab, which is not what a
 * lead is for.
 *
 * The field is a LENGTH, so it is the arc length of the lead, not its radius —
 * "20mm lead-in" should put 20mm of travel in front of the cut.
 *
 * @param {Array<Object>} cuts - what `planPass` returned
 * @param {Object} j - the job's resolved values
 * @returns {Array<Array<Number[]>>} the points of each run
 */
function withLeads(cuts, j) {

	const points = cuts.map((cut) => cut.points);

	if (points.length === 0)
		return points;

	if (j.leadIn > 0) {
		const lead = leadIn(points[0], {
			radius: j.leadIn / LEAD_SWEEP, side: j.leadSide, sweepRadians: LEAD_SWEEP,
		});
		points[0] = [...lead, ...points[0]];
	}

	if (j.leadOut > 0) {
		const last = points.length - 1;
		const lead = leadOut(points[last], {
			radius: j.leadOut / LEAD_SWEEP, side: j.leadSide, sweepRadians: LEAD_SWEEP,
		});
		points[last] = [...points[last], ...lead];
	}

	return points;
}
