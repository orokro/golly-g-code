/**
 * @file program.js
 * @description Turns a plan of jobs, passes and runs into a G-code program.
 *
 * This module owns the ORDER and the SAFETY of the output; the dialect owns the
 * wording. It knows that a rapid across the work happens at safe Z and never at
 * cutting depth, that the spindle is running before the tool touches anything,
 * and that a tool change stops the spindle first.
 *
 * ## Breadcrumbs
 *
 * Each job's lines are wrapped in `;<job …>` / `;</job>` comments. They are not
 * decoration: the Timeline maps G-code line numbers back to jobs, the editor
 * highlights the block belonging to the selected job, and it is what would make
 * a round-trip import possible later. Comments are the only place to put this
 * that no controller will object to.
 *
 * ## The invariant worth stating
 *
 * Between any two cutting runs the tool goes up to safe Z, moves, and comes back
 * down. There is no path through this module that rapids in X or Y while below
 * safe Z. That is what makes a tab (1.7) a break rather than a gouge, and it is
 * asserted in the tests rather than left to reading.
 */

import { grbl } from './grbl.js';

/** Where the tool is assumed to be before the program starts: nowhere known. */
const UNKNOWN = Object.freeze({ x: NaN, y: NaN, z: NaN });


/**
 * Emits a G-code program.
 *
 * @param {Object} plan - the program to emit
 * @param {Number} plan.safeZ - Z to travel at, millimetres, above the work
 * @param {Array<Object>} plan.jobs - each `{ name, tool, feeds, passes }`, where
 *   tool is `{ number, diameter, rpm }`, feeds is `{ cut, plunge }` in mm/min,
 *   and passes is `[{ z, runs }]` with runs an array of polylines
 * @param {Object} [plan.program] - optional `{ name }` for the header comment
 * @param {Object} [options] - options
 * @param {Object} [options.dialect] - the dialect; a default GRBL post if absent
 * @param {Number} [options.spindleDwell=2] - seconds to let the spindle spin up
 * @returns {Object} `{ lines, warnings, stats }`
 * @throws {RangeError} when the plan is unusable
 */
export function emitProgram(plan, options = {}) {

	const { dialect = grbl(), spindleDwell = 2 } = options;
	const { safeZ, jobs = [] } = plan;

	if (!Number.isFinite(safeZ))
		throw new RangeError(`safeZ must be a finite number, got ${safeZ}`);

	// The "never travel below safe Z" guard is stated relative to safeZ, so it
	// cannot catch a safeZ that is itself below the work — every rapid would be
	// at or above it and every one of them would be dragging the cutter through
	// the material. Checked here instead, once, against the actual cuts.
	for (const job of jobs)
		for (const pass of job.passes ?? [])
			if (!(pass.z < safeZ))
				throw new RangeError(`safe Z of ${safeZ} is not above a pass cutting to ${pass.z};`
					+ ' every rapid would drag the cutter through the work');

	const lines = [];
	const warnings = [];
	const stats = { rapids: 0, cuts: 0, plunges: 0, toolChanges: 0 };

	let at = { ...UNKNOWN };
	let feedRate = null;
	let tool = null;

	/**
	 * Adds a line, skipping the nulls a dialect returns for a move of nothing.
	 *
	 * @param {String|String[]|null} produced - what the dialect gave back
	 */
	const put = (produced) => {
		for (const line of [produced].flat())
			if (line !== null && line !== undefined)
				lines.push(line);
	};

	/**
	 * Rapids somewhere, tracking position. Refuses to travel below safe Z.
	 *
	 * @param {Object} to - `{ x, y, z }` in millimetres, any may be undefined
	 */
	const rapidTo = (to) => {
		const movesInPlane = (to.x !== undefined && to.x !== at.x)
			|| (to.y !== undefined && to.y !== at.y);
		if (movesInPlane && at.z < safeZ)
			throw new RangeError('refusing to rapid across the work below safe Z'
				+ ` (at Z${at.z}, safe Z${safeZ})`);

		const line = dialect.rapid(to, at);
		if (line !== null) {
			lines.push(line);
			stats.rapids++;
		}
		at = { ...at, ...to };
	};

	/**
	 * Cuts somewhere at a feed, tracking position and modal feed.
	 *
	 * @param {Object} to - `{ x, y, z }` in millimetres
	 * @param {Number} rate - feed in mm/min
	 */
	const feedTo = (to, rate) => {
		const line = dialect.feed(to, at, rate === feedRate ? null : rate);
		if (line !== null) {
			lines.push(line);
			stats.cuts++;
			feedRate = rate;
		}
		at = { ...at, ...to };
	};

	put(dialect.comment(`${plan.program?.name ?? 'GollyGCode'} — ${dialect.name}`));
	put(dialect.preamble());

	for (const job of jobs) {

		const { name = 'job', tool: jobTool = {}, feeds = {}, passes = [] } = job;
		const cut = feeds.cut;
		const plunge = feeds.plunge ?? feeds.cut;

		if (!(cut > 0))
			throw new RangeError(`job '${name}' has no cutting feed rate`);

		lines.push(`;<job name="${String(name).replace(/["<>\n\r]/g, '')}">`);

		// a new tool means stop, retract, pause for the operator, spin up again
		const changed = tool !== null && jobTool.number !== tool.number;
		if (changed) {
			put(dialect.spindleOff());
			rapidTo({ z: safeZ });
			put(dialect.comment(`change to tool ${jobTool.number}`
				+ `${jobTool.diameter ? ` — ${jobTool.diameter}mm` : ''}`));
			put(dialect.toolChange());
			stats.toolChanges++;
		}

		if (tool === null || changed || jobTool.rpm !== tool.rpm) {
			put(dialect.spindleOn(jobTool.rpm ?? 0));
			if (spindleDwell > 0)
				put(dialect.dwell(spindleDwell));
		}

		tool = jobTool;

		for (const pass of passes) {

			for (const run of pass.runs ?? []) {

				const points = run.points ?? run;

				if (points.length < 2) {
					warnings.push(`job '${name}' had a run of ${points.length} point(s), skipped`);
					continue;
				}

				// up, across, down — never across at depth
				rapidTo({ z: safeZ });
				rapidTo({ x: points[0][0], y: points[0][1] });
				feedTo({ z: pass.z }, plunge);
				stats.plunges++;

				for (const [x, y] of points.slice(1))
					feedTo({ x, y }, cut);
			}
		}

		lines.push(';</job>');
	}

	if (Number.isFinite(at.z) && at.z < safeZ)
		rapidTo({ z: safeZ });

	put(dialect.postamble());

	return { lines, warnings, stats };
}


/**
 * The program as a single string, newline separated, with a trailing newline.
 *
 * @param {Object} plan - as emitProgram
 * @param {Object} [options] - as emitProgram
 * @returns {Object} `{ text, warnings, stats }`
 */
export function emitText(plan, options = {}) {

	const { lines, warnings, stats } = emitProgram(plan, options);

	return { text: `${lines.join('\n')}\n`, warnings, stats };
}
