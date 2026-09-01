import { describe, it, expect } from 'vitest';

import { NodeType, FolderRole, Combine, createNode } from './nodes.js';
import { createProject } from './document.js';
import { folderOf } from './tree.js';
import { prepareSvgImport } from './import.js';
import { prepareJob } from './jobs.js';
import { generateJobToolpath, generateAll } from './toolpaths.js';

/** Deterministic ids. */
const counter = (prefix = 'n') => { let k = 0; return () => `${prefix}${(k += 1)}`; };

/** A 40mm square, an open zigzag, and a second 40mm square overlapping the first. */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="200mm"'
	+ ' viewBox="0 0 200 200">'
	+ '<rect id="square" x="20" y="20" width="40" height="40"/>'
	+ '<path id="zigzag" d="M100 20 L120 40 L140 20"/>'
	+ '<rect id="overlap" x="40" y="20" width="40" height="40"/>'
	+ '</svg>';

/**
 * A project with that drawing imported and one job owning a copy of chosen paths.
 *
 * Built through `prepareJob`, which is how the application makes a job: the
 * outline is COPIED into the job and the geometry it returns goes into the side
 * store. Handing the job a hand-written outline instead would be a fixture that
 * agrees with nothing.
 *
 * @param {Object} [job] - fields for the job
 * @param {String[]} [want] - which shapes, by name
 * @returns {Object} `{ project, jobId, byName }`
 */
function fixture(job = {}, want = ['square']) {

	const newId = counter();
	const project = createProject({ newId });
	const document = project.document;

	const prepared = prepareSvgImport(SVG, { filename: 'a.svg', newId });
	Object.assign(project.geometry, prepared.geometry);
	project.sources[prepared.source] = SVG;

	for (const node of prepared.nodes)
		document.nodes[node.id] = node;

	folderOf(document, FolderRole.SVGS).children.push(prepared.doc.id);

	const byName = Object.fromEntries(prepared.nodes
		.filter((node) => node.type === NodeType.SVG_PATH)
		.map((node) => [node.name, node.id]));

	const tool = createNode(NodeType.TOOL, { name: 'Bit' }, { newId });
	const madeJob = prepareJob(project, want.map((name) => byName[name]),
		{ newId, name: 'Cut', fields: job });
	const jobNode = madeJob.job;

	Object.assign(project.geometry, madeJob.geometry);

	tool.children = [jobNode.id];
	document.nodes[tool.id] = tool;
	document.nodes[jobNode.id] = jobNode;
	folderOf(document, FolderRole.JOBS).children.push(tool.id);

	return { project, jobId: jobNode.id, toolId: tool.id, byName };
}

/**
 * The bounding box of a set of `{ points }` runs.
 *
 * @param {Object[]} paths - runs
 * @returns {Object} the box
 */
function bounds(paths) {
	const points = paths.flatMap((path) => path.points);
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}


describe('a closed contour', () => {

	it('cuts OUTSIDE by half the tool, so the cut’s edge lands on the line', () => {
		// a 40mm square with a 3.175mm tool: the toolpath centre runs 1.5875mm
		// outside the line on every side, so it is 43.175mm across
		const f = fixture({ operation: 'outside', cutDepth: 1 });
		const result = generateJobToolpath(f.project, f.jobId);
		const box = bounds(result.paths);

		expect(result.paths.length).toBeGreaterThan(0);
		expect(box.maxX - box.minX).toBeCloseTo(40 + 3.175, 2);
		expect(box.maxY - box.minY).toBeCloseTo(40 + 3.175, 2);
	});

	it('cuts INSIDE by half the tool, the other way', () => {
		const f = fixture({ operation: 'inside', cutDepth: 1 });
		const box = bounds(generateJobToolpath(f.project, f.jobId).paths);

		expect(box.maxX - box.minX).toBeCloseTo(40 - 3.175, 2);
	});

	it('cuts CENTRE exactly on the line', () => {
		const f = fixture({ operation: 'center', cutDepth: 1 });
		const box = bounds(generateJobToolpath(f.project, f.jobId).paths);

		expect(box.maxX - box.minX).toBeCloseTo(40, 3);
	});

	it('leaves a margin when asked, on top of the tool', () => {
		const f = fixture({ operation: 'outside', cutDepth: 1, margin: 2 });
		const box = bounds(generateJobToolpath(f.project, f.jobId).paths);

		expect(box.maxX - box.minX).toBeCloseTo(40 + 3.175 + 4, 2);
	});

	it('gives one pass per depth step, ending exactly at the target', () => {
		const f = fixture({ operation: 'outside', cutDepth: 5 });
		const result = generateJobToolpath(f.project, f.jobId);

		expect(result.depths).toHaveLength(5);
		expect(result.depths.at(-1)).toBeCloseTo(-5, 9);
	});

	it('clears a POCKET with more than one ring', () => {
		const f = fixture({ operation: 'pocket', cutDepth: 1 });
		const result = generateJobToolpath(f.project, f.jobId);

		expect(result.paths.length).toBeGreaterThan(1);
	});
});


describe('an open path', () => {

	it('follows the line exactly in CENTRE', () => {
		const f = fixture({ operation: 'center', cutDepth: 1 }, ['zigzag']);
		const box = bounds(generateJobToolpath(f.project, f.jobId).paths);

		expect(box.maxX - box.minX).toBeCloseTo(40, 3);
		expect(box.maxY - box.minY).toBeCloseTo(20, 3);
	});

	it('offsets by the tool’s RADIUS in HEADING, so the cut’s edge is on the line', () => {
		// not the diameter: what the user means by "offset by the tool" is that
		// the EDGE of the cut lands where they drew
		const f = fixture({ operation: 'heading', cutDepth: 1, offsetHeading: Math.PI / 2 }, ['zigzag']);
		const result = generateJobToolpath(f.project, f.jobId);
		const box = bounds(result.paths);
		const source = bounds(result.source);

		expect(box.minY - source.minY).toBeCloseTo(3.175 / 2, 6);
		expect(result.congruent).toBe(true);
	});

	it('says a NORMAL offset is not congruent, which is what tab placement needs', () => {
		const f = fixture({ operation: 'normal', cutDepth: 1 }, ['zigzag']);

		expect(generateJobToolpath(f.project, f.jobId).congruent).toBe(false);
	});

	it('takes an open path along for the ride on a centre cut', () => {
		const f = fixture({ operation: 'center', cutDepth: 1 }, ['square', 'zigzag']);

		expect(generateJobToolpath(f.project, f.jobId).paths.length).toBeGreaterThan(1);
	});
});


describe('combining', () => {

	it('leaves the paths alone by default', () => {
		const f = fixture({ operation: 'outside', cutDepth: 1 }, ['square', 'overlap']);
		const result = generateJobToolpath(f.project, f.jobId);

		// two separate squares, each offset -- 80mm across in total plus the tool
		expect(bounds(result.paths).maxX - bounds(result.paths).minX).toBeCloseTo(60 + 3.175, 1);
	});

	it('unions them when asked, so the shared edge is not cut twice', () => {
		// three overlapping circles cut separately re-cut air the earlier ones
		// already cleared; this is the same thing with squares
		const f = fixture({ operation: 'outside', cutDepth: 1, combine: Combine.UNION },
			['square', 'overlap']);
		const result = generateJobToolpath(f.project, f.jobId);

		expect(result.paths).toHaveLength(1);
		expect(bounds(result.paths).maxX - bounds(result.paths).minX).toBeCloseTo(60 + 3.175, 1);
	});

	it('takes the first path minus the rest for DIFFERENCE', () => {
		const f = fixture({ operation: 'outside', cutDepth: 1, combine: Combine.DIFFERENCE },
			['square', 'overlap']);
		const box = bounds(generateJobToolpath(f.project, f.jobId).paths);

		// the left 20mm of the first square survives
		expect(box.maxX - box.minX).toBeCloseTo(20 + 3.175, 1);
	});

	it('says so rather than guessing at a mode it does not know', () => {
		const f = fixture({ operation: 'outside', cutDepth: 1, combine: 'none' }, ['square']);
		f.project.document.nodes[f.jobId].combine = 'sideways';

		expect(generateJobToolpath(f.project, f.jobId).warnings.join(' ')).toMatch(/Unknown combine mode/);
	});
});


describe('saying what it could not do', () => {

	it('reports open paths an inside cut cannot use, rather than skipping them', () => {
		// a job that emitted three of its four paths and said nothing is exactly
		// what "no silent failures" is for
		const f = fixture({ operation: 'inside', cutDepth: 1 }, ['square', 'zigzag']);
		const result = generateJobToolpath(f.project, f.jobId);

		expect(result.warnings.join(' ')).toMatch(/1 open path cannot be cut "inside"/);
		expect(result.paths.length).toBeGreaterThan(0);
	});

	it('reports closed paths a heading offset cannot use', () => {
		const f = fixture({ operation: 'heading', cutDepth: 1 }, ['square', 'zigzag']);

		expect(generateJobToolpath(f.project, f.jobId).warnings.join(' '))
			.toMatch(/1 closed path cannot be cut "heading"/);
	});

	it('says when the geometry is missing rather than drawing nothing', () => {
		// the job's OWN outline, now that it has one: losing the drawing's copy is
		// no longer something the cut can even notice
		const f = fixture({ operation: 'outside', cutDepth: 1 });
		delete f.project.geometry[f.project.document.nodes[f.jobId].geometry];

		const result = generateJobToolpath(f.project, f.jobId);

		expect(result.warnings.join(' ')).toMatch(/has no outline of its own to cut/);
		expect(result.paths).toEqual([]);
	});

	it('says when there is no depth or no tool to cut with', () => {
		const f = fixture({ operation: 'outside', cutDepth: 1 });
		f.project.document.nodes[f.toolId].diameter = 0;

		expect(generateJobToolpath(f.project, f.jobId).warnings.join(' '))
			.toMatch(/needs a cut depth and a tool diameter/);
	});

	it('refuses a node that is not a job, or a job with no tool above it', () => {
		const f = fixture();

		expect(() => generateJobToolpath(f.project, f.project.document.root))
			.toThrow(/is not a job/);

		const loose = createNode(NodeType.JOB, { name: 'Loose' }, { newId: () => 'loose' });
		f.project.document.nodes.loose = loose;
		expect(() => generateJobToolpath(f.project, 'loose'))
			.toThrow(/not inside a tool group/);
	});
});


describe('the whole project', () => {

	it('generates every job in cutting order', () => {
		const f = fixture({ operation: 'outside', cutDepth: 1 });
		const all = generateAll(f.project);

		expect(all).toHaveLength(1);
		expect(all[0].jobId).toBe(f.jobId);
		expect(all[0].paths.length).toBeGreaterThan(0);
	});

	it('does not let one broken job blank the whole preview', () => {
		const f = fixture({ operation: 'outside', cutDepth: 1 });
		f.project.document.nodes[f.toolId].children.push('ghost');

		expect(() => generateAll(f.project)).not.toThrow();
	});
});


describe('holding tabs ride along with the toolpath', () => {

	/**
	 * The fixture's job, with tabs hung under it.
	 *
	 * @param {Array<Object>} tabs - fields for each tab
	 * @param {Object} [job] - fields for the job
	 * @returns {Object} the fixture
	 */
	const withTabs = (tabs, job = {}) => {
		const newId = counter('t');
		const f = fixture({ operation: 'outside', cutDepth: 2, ...job });
		const node = f.project.document.nodes[f.jobId];
		node.children = tabs.map((fields) => {
			const tab = createNode(NodeType.TAB, { name: 'Tab', ...fields }, { newId });
			f.project.document.nodes[tab.id] = tab;
			return tab.id;
		});
		return f;
	};

	it('resolves a tab onto the run it actually sits on', () => {
		const f = withTabs([{ position: 20, length: 6, depth: 1 }]);
		const result = generateJobToolpath(f.project, f.jobId);

		expect(result.tabSpans).toHaveLength(result.paths.length);
		expect(result.tabSpans.flat()).toHaveLength(1);
		expect(result.tabSpans.flat()[0].end - result.tabSpans.flat()[0].start).toBeCloseTo(6, 1);
	});

	it('gives every run an entry, even the ones with no tab on them', () => {
		// the emitter indexes tabSpans by run, so a short array is an off-by-one
		// waiting to happen rather than an absence
		const f = withTabs([]);
		const result = generateJobToolpath(f.project, f.jobId);
		expect(result.tabSpans).toHaveLength(result.paths.length);
		expect(result.tabSpans.every(Array.isArray)).toBe(true);
	});

	it('merges two tabs that share material into one bridge', () => {
		const f = withTabs([
			{ position: 20, length: 8, depth: 1 },
			{ position: 23, length: 8, depth: 1 },
		]);
		const result = generateJobToolpath(f.project, f.jobId);
		expect(result.tabSpans.flat()).toHaveLength(1);
	});

	it('says so when a tab is narrower than the cutter', () => {
		const f = withTabs([{ position: 20, length: 1, depth: 1 }]);
		const result = generateJobToolpath(f.project, f.jobId);
		expect(result.warnings.join(' ')).toMatch(/not wider than/);
	});

	it('is empty, not missing, when the job could not be cut at all', () => {
		const f = withTabs([{ position: 20, length: 6, depth: 1 }], { cutDepth: 0 });
		expect(generateJobToolpath(f.project, f.jobId).tabSpans).toEqual([]);
	});
});


describe('an open path is TRACED, never closed', () => {

	/**
	 * A job over the zigzag, which is open.
	 *
	 * @param {Object} [job] - fields for the job
	 * @returns {Object} the result of generating it
	 */
	const traceZigzag = (job = {}) => {
		const f = fixture({ operation: 'center', cutDepth: 1, ...job }, ['zigzag']);
		return { result: generateJobToolpath(f.project, f.jobId), f };
	};

	it('comes back open, not as a ring', () => {

		// The bug Greg found on a drawing of the Painted Ladies. The first thing
		// `generateToolpath` does is normalize its input through clipper, which is
		// a boolean union and so treats every contour as a CLOSED POLYGON — an
		// open skyline came back as a closed ring with a cut straight across the
		// bottom of the part that nobody had drawn.
		const { result } = traceZigzag();

		expect(result.paths).toHaveLength(1);
		expect(result.paths[0].closed).toBe(false);
	});

	it('traces the drawn line exactly, point for point', () => {

		// Not merely "open": the same points. Anything that had been through
		// clipper would come back with a different vertex count and different
		// coordinates even if the closed flag were then patched to false.
		const { result } = traceZigzag();
		const source = result.source[0].points;
		const cut = result.paths[0].points;

		expect(cut).toHaveLength(source.length);
		expect(cut[0]).toEqual(source[0]);
		expect(cut.at(-1)).toEqual(source.at(-1));
	});

	it('does not join its two ends, however far apart they are', () => {
		const { result } = traceZigzag();
		const points = result.paths[0].points;
		const gap = Math.hypot(points[0][0] - points.at(-1)[0], points[0][1] - points.at(-1)[1]);
		expect(gap).toBeGreaterThan(1);
	});

	it('engraves an open path the same way', () => {
		const { result } = traceZigzag({ operation: 'engrave' });
		expect(result.paths[0].closed).toBe(false);
	});

	it('still gets depth passes even with nothing closed to offset', () => {
		const { result } = traceZigzag({ cutDepth: 3, passDepth: 1 });
		expect(result.depths).toEqual([-1, -2, -3]);
	});

	it('says the margin was ignored rather than silently offsetting nothing', () => {

		// A margin moves a closed contour in or out. An open line has no side to
		// offset toward, which is what the normal and heading modes are for — so
		// the honest answer is to trace it and say the margin did nothing.
		const { result } = traceZigzag({ margin: 2 });
		expect(result.warnings.join(' ')).toMatch(/margin was ignored/);
	});

	it('cuts the closed shapes and traces the open ones, in one job', () => {

		// A job holding both: the square is offset by clipper, the zigzag is not.
		const f = fixture({ operation: 'center', cutDepth: 1 }, ['square', 'zigzag']);
		const result = generateJobToolpath(f.project, f.jobId);

		expect(result.paths.filter((path) => path.closed)).toHaveLength(1);
		expect(result.paths.filter((path) => path.closed === false)).toHaveLength(1);
	});
});
