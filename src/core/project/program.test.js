/**
 * @file program.test.js
 * @description Tests for the document-to-G-code seam.
 *
 * The rule this file is written under: measure the EMITTED PROGRAM, by parsing
 * it back with `core/post/parse.js` and taking a ruler to the moves. Asserting
 * on the plan would only be checking that the object I built is the object I
 * built; a 60mm square has to come out 63.175mm across in the actual file, and
 * the only way to know that is to read the file.
 */

import { describe, it, expect } from 'vitest';

import { NodeType, FolderRole, createNode } from './nodes.js';
import { createProject } from './document.js';
import { folderOf } from './tree.js';
import { prepareSvgImport } from './import.js';
import { prepareJob } from './jobs.js';
import { buildPlan, generateProgram, mapBlocks } from './program.js';
import { parseGCode } from '../post/parse.js';

/** Deterministic ids. */
const counter = (prefix = 'n') => { let k = 0; return () => `${prefix}${(k += 1)}`; };

/** A 60mm square and an open zigzag, in a drawing with a real physical size. */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="200mm"'
	+ ' viewBox="0 0 200 200">'
	+ '<rect id="square" x="20" y="20" width="60" height="60"/>'
	+ '<path id="zigzag" d="M100 20 L130 50 L160 20"/>'
	+ '</svg>';


/**
 * A project with that drawing imported, and one tool group per job description.
 *
 * @param {Array<Object>} [jobs] - `{ paths, tabs, ...fields }` per job; `paths`
 *   names the shapes the job's outline is COPIED from, `tabs` is an array of tab
 *   field objects, `tool` is fields for the tool group it goes in. Each entry
 *   gets its own tool group
 * @param {Object} [settings] - fields for the Project node
 * @returns {Object} `{ project, ids }` where ids maps job name to node id
 */
function fixture(jobs = [{}], settings = {}) {

	const newId = counter();
	const project = createProject({ newId });
	const { document } = project;

	Object.assign(document.nodes[document.root], settings);

	const prepared = prepareSvgImport(SVG, { filename: 'a.svg', newId });
	Object.assign(project.geometry, prepared.geometry);
	project.sources[prepared.source] = SVG;

	for (const node of prepared.nodes)
		document.nodes[node.id] = node;

	folderOf(document, FolderRole.SVGS).children.push(prepared.doc.id);

	const byName = Object.fromEntries(prepared.nodes
		.filter((node) => node.type === NodeType.SVG_PATH)
		.map((node) => [node.name, node.id]));

	/** @type {Object<String, String>} */
	const ids = {};

	jobs.forEach((spec, index) => {

		const { paths = ['square'], tabs = [], tool: toolFields = {}, ...fields } = spec;

		const tool = createNode(NodeType.TOOL, { name: `Bit ${index + 1}`, ...toolFields }, { newId });

		// through `prepareJob`, because that is how the application makes a job:
		// the outline is copied into the job and the geometry it returns is merged
		// into the side store
		const made = prepareJob(project, paths.map((name) => byName[name]), {
			newId,
			name: fields.name ?? `Cut ${index + 1}`,
			fields: { cutDepth: 1, ...fields },
		});
		const job = made.job;

		Object.assign(project.geometry, made.geometry);

		tool.children = [job.id];
		job.children = tabs.map((tabFields) => {
			const tab = createNode(NodeType.TAB, { name: 'Tab', ...tabFields }, { newId });
			document.nodes[tab.id] = tab;
			return tab.id;
		});

		document.nodes[tool.id] = tool;
		document.nodes[job.id] = job;
		folderOf(document, FolderRole.JOBS).children.push(tool.id);

		ids[job.name] = job.id;
		ids[`tool:${job.name}`] = tool.id;
	});

	return { project, ids, byName };
}


/**
 * The moves of a program, parsed back out of the text it actually emitted.
 *
 * @param {String} text - the program
 * @returns {Array<Object>} the moves
 */
const movesOf = (text) => {
	const { moves, warnings } = parseGCode(text);
	expect(warnings).toEqual([]);
	return moves;
};

/** Just the moves that remove material: fed, and below the surface. */
const cutting = (moves) => moves.filter((m) => m.kind !== 'rapid' && m.to.z < 0 && m.from.z < 0);

/**
 * The bounding box of a set of moves, by their endpoints.
 *
 * @param {Array<Object>} moves - the moves
 * @returns {Object} `{ width, height, minX, minY }`
 */
function box(moves) {
	const points = moves.flatMap((m) => [m.from, m.to]);
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const minX = Math.min(...xs);
	const minY = Math.min(...ys);
	return { minX, minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** The distinct Z levels cut at, deepest last. */
const depthsIn = (moves) =>
	[...new Set(cutting(moves).map((m) => Number(m.to.z.toFixed(6))))].sort((a, b) => b - a);


describe('the program measures what the drawing asked for', () => {

	it('cuts a 60mm square outside at 63.175mm across, in the emitted file', () => {

		// The whole point of the exercise, end to end: an SVG rect, through the
		// document, through cam, through the post, parsed back, measured.
		const f = fixture([{ operation: 'outside', ramp: false }]);
		const { text, warnings } = generateProgram(f.project);

		const moves = movesOf(text);
		const measured = box(cutting(moves));

		expect(warnings).toEqual([]);
		expect(measured.width).toBeCloseTo(63.175, 2);
		expect(measured.height).toBeCloseTo(63.175, 2);
	});

	it('cuts the same square inside at 56.825mm', () => {
		const f = fixture([{ operation: 'inside', ramp: false }]);
		const measured = box(cutting(movesOf(generateProgram(f.project).text)));
		expect(measured.width).toBeCloseTo(56.825, 2);
		expect(measured.height).toBeCloseTo(56.825, 2);
	});

	it('rebases every coordinate on the work zero', () => {

		const plain = fixture([{ operation: 'outside', ramp: false }]);
		const moved = fixture([{ operation: 'outside', ramp: false }],
			{ workZero: { x: 20, y: 10 } });

		const a = box(cutting(movesOf(generateProgram(plain.project).text)));
		const b = box(cutting(movesOf(generateProgram(moved.project).text)));

		expect(b.minX).toBeCloseTo(a.minX - 20, 6);
		expect(b.minY).toBeCloseTo(a.minY - 10, 6);
		expect(b.width).toBeCloseTo(a.width, 6);
	});
});


describe('depth', () => {

	it('steps down in passes and lands exactly on the target', () => {
		const f = fixture([{ operation: 'outside', cutDepth: 3, passDepth: 1, ramp: false }]);
		expect(depthsIn(movesOf(generateProgram(f.project).text))).toEqual([-1, -2, -3]);
	});

	it('makes the last pass short rather than cutting deeper than asked', () => {
		const f = fixture([{ operation: 'outside', cutDepth: 2.5, passDepth: 1, ramp: false }]);
		expect(depthsIn(movesOf(generateProgram(f.project).text))).toEqual([-1, -2, -2.5]);
	});
});


describe('the invariant that keeps the cutter out of the work', () => {

	it('never rapids in X or Y below safe Z, in the emitted file', () => {

		// Asserted on the parsed program rather than on the emitter's internals,
		// because the file is what the machine reads.
		const f = fixture([
			{ operation: 'outside', cutDepth: 3, passDepth: 1, tabs: [{ position: 30, depth: 0 }] },
			{ operation: 'inside', cutDepth: 2, passDepth: 1 },
		], { safeZ: 5 });

		const offending = movesOf(generateProgram(f.project).text)
			.filter((m) => m.kind === 'rapid')
			.filter((m) => (m.to.x !== m.from.x || m.to.y !== m.from.y))
			.filter((m) => m.from.z < 5 || m.to.z < 5);

		expect(offending).toEqual([]);
	});

	it('never rapids down past a depth the job has not already cut', () => {

		// Rapids DOWN are how a ramp gets to its starting height, and they are the
		// one place a G0 legitimately goes below the surface. Legitimately means:
		// no deeper than this job has already been at. Two jobs stepping down by
		// different amounts is what breaks a version of this that looks at the
		// whole program, so the fixture uses 2mm and 2.5mm on purpose.
		const f = fixture([
			{ name: 'Coarse', operation: 'outside', cutDepth: 4, passDepth: 2, ramp: true },
			{ name: 'Fine', operation: 'inside', cutDepth: 5, passDepth: 2.5, ramp: true },
		]);

		const { text, blocks } = generateProgram(f.project);
		const moves = movesOf(text);

		for (const block of blocks) {

			let deepest = 0;

			for (const move of moves.filter((m) => m.line >= block.from && m.line <= block.to)) {

				if (move.kind === 'rapid' && move.to.z < move.from.z)
					expect(move.to.z, `${block.name} rapids to ${move.to.z}, cut only to ${deepest}`)
						.toBeGreaterThanOrEqual(deepest - 1e-9);

				if (move.kind !== 'rapid')
					deepest = Math.min(deepest, move.to.z);
			}
		}
	});

	it('has the spindle running before the first cut', () => {
		const f = fixture([{ operation: 'outside' }]);
		const moves = movesOf(generateProgram(f.project).text);
		expect(cutting(moves).length).toBeGreaterThan(0);
		expect(cutting(moves).every((m) => m.spindle > 0)).toBe(true);
	});
});


describe('tabs become breaks in the cut', () => {

	/**
	 * How many separate cutting runs happen at one Z, counted as the number of
	 * times the tool re-enters the material at that depth.
	 *
	 * @param {Array<Object>} moves - the parsed moves
	 * @param {Number} z - the pass depth
	 * @returns {Number} the run count
	 */
	const runsAt = (moves, z) => {
		let runs = 0;
		let inside = false;
		for (const move of moves) {
			const cuts = move.kind !== 'rapid' && Math.abs(move.to.z - z) < 1e-6 && move.from.z < 0;
			if (cuts && !inside)
				runs++;
			inside = cuts;
		}
		return runs;
	};

	it('breaks only the passes that would cut below the tab', () => {

		// A 1mm deep tab in 3mm of cut: passes at -1 run straight through it,
		// passes at -2 and -3 have to go round.
		const f = fixture([{
			operation: 'outside', cutDepth: 3, passDepth: 1, ramp: false,
			tabs: [{ position: 30, length: 6, depth: 1 }],
		}]);

		const moves = movesOf(generateProgram(f.project).text);

		expect(runsAt(moves, -1)).toBe(1);
		expect(runsAt(moves, -2)).toBe(2);
		expect(runsAt(moves, -3)).toBe(2);
	});

	it('leaves a gap the width of the tab, measured on the toolpath', () => {

		// The tab sits mid-way along the first edge, which is straight, so the
		// bridge on the toolpath is the 6mm asked for and not a projection of it.
		const f = fixture([{
			operation: 'outside', cutDepth: 2, passDepth: 1, ramp: false,
			tabs: [{ position: 30, length: 6, depth: 0 }],
		}]);

		const moves = movesOf(generateProgram(f.project).text);
		const deep = moves.filter((m) => Math.abs(m.to.z + 2) < 1e-6 && m.from.z < 0 && m.kind !== 'rapid');

		// the gap is the distance between where one run stopped and the next began
		const gaps = [];
		for (let i = 1; i < deep.length; i++)
			if (deep[i].from.x !== deep[i - 1].to.x || deep[i].from.y !== deep[i - 1].to.y)
				gaps.push(Math.hypot(deep[i].from.x - deep[i - 1].to.x, deep[i].from.y - deep[i - 1].to.y));

		expect(gaps).toHaveLength(1);
		expect(gaps[0]).toBeCloseTo(6, 1);
	});

	it('cuts straight through when every tab is above the whole cut', () => {
		const f = fixture([{
			operation: 'outside', cutDepth: 1, passDepth: 1, ramp: false,
			tabs: [{ position: 30, length: 6, depth: 4 }],
		}]);
		expect(runsAt(movesOf(generateProgram(f.project).text), -1)).toBe(1);
	});

	it('places a tab by its position in millimetres along the source', () => {

		// The distinguishing case for the unit. The square's first edge starts at
		// a corner; a tab 5mm along and a tab 30mm along land in different places,
		// and a fraction-based reading would put both of them at the very start.
		const near = fixture([{
			operation: 'outside', cutDepth: 2, passDepth: 1, ramp: false,
			tabs: [{ position: 5, length: 4, depth: 0 }],
		}]);
		const far = fixture([{
			operation: 'outside', cutDepth: 2, passDepth: 1, ramp: false,
			tabs: [{ position: 30, length: 4, depth: 0 }],
		}]);

		/**
		 * Where the gap in the deepest pass is.
		 *
		 * @param {Object} f - the fixture
		 * @returns {Object} the point the cut stopped at
		 */
		const gapAt = (f) => {
			const deep = movesOf(generateProgram(f.project).text)
				.filter((m) => Math.abs(m.to.z + 2) < 1e-6 && m.from.z < 0 && m.kind !== 'rapid');
			for (let i = 1; i < deep.length; i++)
				if (deep[i].from.x !== deep[i - 1].to.x || deep[i].from.y !== deep[i - 1].to.y)
					return deep[i - 1].to;
			throw new Error('no gap found');
		};

		const a = gapAt(near);
		const b = gapAt(far);

		expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(25, 1);
	});
});


describe('tools', () => {

	it('numbers each tool group and changes between them, spindle off first', () => {

		const f = fixture([
			{ name: 'A', operation: 'outside' },
			{ name: 'B', operation: 'inside', tool: { diameter: 6 } },
		]);

		const { text } = generateProgram(f.project);
		const lines = text.split('\n');

		// There is no ATC on this machine, so a tool change is a program pause
		// and a comment telling the operator which bit to fit. The comment is not
		// decoration here: it is the entire instruction.
		const change = lines.findIndex((line) => line === 'M0');
		expect(change).toBeGreaterThan(0);
		expect(lines[change - 1]).toMatch(/change to tool 2 — 6mm/);

		// the spindle stops before a hand goes near the collet
		expect(lines.slice(0, change).some((line) => line === 'M5')).toBe(true);

		// and starts again before anything is cut with the new one
		expect(lines.slice(change).some((line) => /^M3\b/.test(line))).toBe(true);
	});

	it('gives two jobs on the same tool one tool number and no change between them', () => {

		const f = fixture([{ name: 'A', operation: 'outside' }, { name: 'B', operation: 'inside' }]);
		const { plan } = buildPlan(f.project);

		// separate tool GROUPS in this fixture, so this is the honest check: the
		// numbers are per group, and both groups are numbered
		expect(plan.jobs.map((job) => job.tool.number)).toEqual([1, 2]);
	});
});


describe('what it refuses, and what it says', () => {

	it('produces nothing at all when a diagnostic blocks export', () => {

		const f = fixture([{ operation: 'outside' }]);
		const blocking = [{ nodeId: f.ids.A ?? 'x', level: 'error', code: 'test', message: 'nope' }];
		const result = generateProgram(f.project, { diagnostics: blocking });

		expect(result.text).toBe('');
		expect(result.lines).toEqual([]);
		expect(result.blocked).toHaveLength(1);
		expect(result.warnings).toEqual(['nope']);
	});

	it('says so when dogbones are asked for, rather than quietly squaring the corners', () => {
		const f = fixture([{ operation: 'inside', dogbones: true }]);
		const { warnings } = generateProgram(f.project);
		expect(warnings.join(' ')).toMatch(/dogbones/);
	});

	it('blocks a job whose only path cannot be cut the way it was asked for', () => {
		// an open path cannot be cut "inside", and diagnostics catch that before
		// a single line is emitted rather than after
		const f = fixture([{ operation: 'inside', paths: ['zigzag'] }]);
		const result = generateProgram(f.project);
		expect(result.text).toBe('');
		expect(result.blocked.map((d) => d.message).join(' ')).toMatch(/needs a closed path/);
	});

	it('passes a job’s own warnings through instead of swallowing them', () => {

		// The job has a closed square to cut, so it is not blocked -- but it also
		// holds an open zigzag that "outside" cannot apply to, and that has to be
		// said out loud rather than dropped on the floor.
		const f = fixture([{ operation: 'outside', paths: ['square', 'zigzag'] }]);
		const { text, warnings } = generateProgram(f.project);

		expect(text).not.toBe('');
		expect(warnings.join(' ')).toMatch(/open path/);
	});
});


describe('entry into the cut', () => {

	/** The moves that take the tool from above the work down to a pass depth. */
	const descents = (moves) => moves.filter((m) => m.kind !== 'rapid' && m.to.z < m.from.z);

	it('plunges straight down when the job says not to ramp', () => {
		const f = fixture([{ operation: 'outside', ramp: false }]);
		const drops = descents(movesOf(generateProgram(f.project).text));
		expect(drops.length).toBeGreaterThan(0);
		expect(drops.every((m) => m.to.x === m.from.x && m.to.y === m.from.y)).toBe(true);
	});

	it('descends along the path when the job asks to ramp', () => {
		const f = fixture([{ operation: 'outside', ramp: true, cutDepth: 2, passDepth: 1 }]);
		const drops = descents(movesOf(generateProgram(f.project).text));
		expect(drops.some((m) => m.to.x !== m.from.x || m.to.y !== m.from.y)).toBe(true);
	});

	it('lets one job ramp while another plunges, in the same program', () => {

		// The reason `ramp` had to stop being a whole-program option: it is a
		// field on the Job, so two jobs in one file must be able to disagree.
		const f = fixture([
			{ name: 'A', operation: 'outside', ramp: true },
			{ name: 'B', operation: 'inside', ramp: false },
		]);

		const { text, blocks } = generateProgram(f.project);
		const moves = movesOf(text);
		const [first, second] = blocks;

		const within = (b) => descents(moves.filter((m) => m.line >= b.from && m.line <= b.to));

		expect(within(first).some((m) => m.to.x !== m.from.x || m.to.y !== m.from.y)).toBe(true);
		expect(within(second).every((m) => m.to.x === m.from.x && m.to.y === m.from.y)).toBe(true);
	});

	it('adds roughly the asked-for length of travel in front of the cut', () => {

		const plain = fixture([{ operation: 'outside', ramp: false }]);
		const led = fixture([{ operation: 'outside', ramp: false, leadIn: 10 }]);

		/** Total fed distance in XY. */
		const travelled = (f) => cutting(movesOf(generateProgram(f.project).text))
			.reduce((sum, m) => sum + Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y), 0);

		expect(travelled(led) - travelled(plain)).toBeCloseTo(10, 0);
	});
});


describe('the line map back to the outliner', () => {

	it('gives each job a range that contains its own cutting and nobody else’s', () => {

		const f = fixture([
			{ name: 'A', operation: 'outside', ramp: false },
			{ name: 'B', operation: 'inside', ramp: false, tool: { diameter: 6 } },
		]);

		const { text, blocks } = generateProgram(f.project);
		const moves = movesOf(text);

		expect(blocks.map((b) => b.name)).toEqual(['A', 'B']);
		expect(blocks.map((b) => b.jobId)).toEqual([f.ids.A, f.ids.B]);

		const inside = (b) => cutting(moves.filter((m) => m.line >= b.from && m.line <= b.to));

		// A is the 60mm square cut outside with a 3.175mm bit; B is the same
		// square cut inside with a 6mm one. Different widths, so the ranges
		// cannot have been swapped or overlapped without this noticing.
		expect(box(inside(blocks[0])).width).toBeCloseTo(63.175, 2);
		expect(box(inside(blocks[1])).width).toBeCloseTo(54, 2);
	});

	it('reads the id out of the breadcrumb, not the name', () => {
		const mapped = mapBlocks([';<job name="Cut" id="n7">', 'G0 Z5', ';</job>']);
		expect(mapped).toEqual([{ jobId: 'n7', name: 'Cut', from: 0, to: 2 }]);
	});

	it('survives a job with no id', () => {
		expect(mapBlocks([';<job name="Cut">', ';</job>']))
			.toEqual([{ jobId: null, name: 'Cut', from: 0, to: 1 }]);
	});
});


describe('the travel between cuts', () => {

	it('joins where one cut stopped to where the next one starts', () => {

		const f = fixture([{ operation: 'outside', cutDepth: 2, passDepth: 1, ramp: false }]);
		const { travel, text } = generateProgram(f.project);
		const moves = movesOf(text);

		expect(travel.length).toBeGreaterThan(0);

		// every travel move must correspond to a real rapid in the emitted file,
		// once the work zero is put back on -- otherwise the layer is drawing a
		// picture of something the machine does not do
		const rapids = moves.filter((m) => m.kind === 'rapid'
			&& (m.to.x !== m.from.x || m.to.y !== m.from.y));

		// to within the dialect's three decimal places -- the picture keeps full
		// precision, the file is rounded, and a micron does not draw
		for (const move of travel)
			expect(rapids.some((r) =>
				Math.abs(r.to.x - move.to[0]) < 0.002 && Math.abs(r.to.y - move.to[1]) < 0.002),
			JSON.stringify(move)).toBe(true);
	});

	it('is in workspace coordinates, so the view can draw it without undoing anything', () => {

		const plain = fixture([{ operation: 'outside', cutDepth: 2, passDepth: 1 }]);
		const moved = fixture([{ operation: 'outside', cutDepth: 2, passDepth: 1 }],
			{ workZero: { x: 20, y: 10 } });

		// the cut moves in the FILE when the puck moves; the picture does not
		expect(generateProgram(moved.project).travel)
			.toEqual(generateProgram(plain.project).travel);
	});

	it('changes when the jobs are reordered, which is the entire point of it', () => {

		// Greg's ask: see how the cutting order affects the movement, rather than
		// argue about it.
		// Two shapes far apart in X, so which way the crossing runs is legible
		// rather than a pair of near-identical coordinates: the square lives
		// around x20-80, the zigzag around x100-160.
		const f = fixture([
			{ name: 'Square', paths: ['square'], operation: 'outside', ramp: false },
			{ name: 'Zigzag', paths: ['zigzag'], operation: 'center', ramp: false },
		]);

		const before = generateProgram(f.project).travel;

		const jobs = folderOf(f.project.document, FolderRole.JOBS);
		jobs.children.reverse();

		const after = generateProgram(f.project).travel;

		// One crossing either way, running the opposite way round. A move belongs
		// to the job it travels INTO, because getting there is part of doing it —
		// which is also what "show me this job's travel" should mean.
		expect(before).toHaveLength(1);
		expect(after).toHaveLength(1);
		expect(after[0].jobId).not.toBe(before[0].jobId);

		expect(before[0].from[0]).toBeLessThan(90);
		expect(before[0].to[0]).toBeGreaterThan(90);

		expect(after[0].from[0]).toBeGreaterThan(90);
		expect(after[0].to[0]).toBeLessThan(90);
	});

	it('has one move per tab break, because that is what a tab costs', () => {

		// A tab is a retract, a rapid across, and a plunge. Two tabs on a contour
		// turn one continuous pass into two crossings -- visible, and the reason
		// somebody might use fewer of them.
		const none = fixture([{ operation: 'outside', cutDepth: 2, passDepth: 1, ramp: false }]);
		const two = fixture([{
			operation: 'outside', cutDepth: 2, passDepth: 1, ramp: false,
			tabs: [{ position: 20, length: 6, depth: 0 }, { position: 130, length: 6, depth: 0 }],
		}]);

		const extra = generateProgram(two.project).travel.length
			- generateProgram(none.project).travel.length;

		// two passes, two tabs, two extra crossings each
		expect(extra).toBe(4);
	});

	it('is empty when nothing can be cut', () => {
		const f = fixture([{ operation: 'outside' }]);
		const blocking = [{ nodeId: 'x', level: 'error', code: 'test', message: 'nope' }];
		expect(generateProgram(f.project, { diagnostics: blocking }).travel).toEqual([]);
	});
});
