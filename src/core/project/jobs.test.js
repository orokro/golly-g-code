/**
 * @file jobs.test.js
 * @description Tests for a job owning its own outline.
 *
 * The decision these are written against, in Greg's words: *"The SVG is for
 * importing shapes, the jobs are the first class objects."* So the tests that
 * matter are the ones about INDEPENDENCE — hide the drawing, move it, delete it,
 * re-import it, and the job cuts exactly what it cut before.
 */

import { describe, it, expect } from 'vitest';

import { NodeType, FolderRole, createNode } from './nodes.js';
import { createProject } from './document.js';
import { folderOf } from './tree.js';
import { prepareSvgImport } from './import.js';
import { prepareJob, outlineOf } from './jobs.js';
import { generateJobToolpath } from './toolpaths.js';
import { diagnose } from './diagnostics.js';

/** Deterministic ids. */
const counter = () => { let k = 0; return () => `n${(k += 1)}`; };

/** A 60 x 40 closed rectangle and an open zigzag. */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="200mm"'
	+ ' viewBox="0 0 200 200">'
	+ '<rect id="plate" x="20" y="20" width="60" height="40"/>'
	+ '<path id="zigzag" d="M100 20 L130 50 L160 20"/>'
	+ '</svg>';


/**
 * A project with that drawing imported, and a job made from one of its paths.
 *
 * @param {String} [want='plate'] - which shape the job is made from
 * @param {Object} [placement] - fields to put on the source path first
 * @returns {Object} everything the tests need
 */
function fixture(want = 'plate', placement = {}) {

	const newId = counter();
	const project = createProject({ newId });
	const { document } = project;

	const prepared = prepareSvgImport(SVG, { filename: 'a.svg', newId });
	Object.assign(project.geometry, prepared.geometry);
	project.sources[prepared.source] = SVG;

	for (const node of prepared.nodes)
		document.nodes[node.id] = node;

	folderOf(document, FolderRole.SVGS).children.push(prepared.doc.id);

	const byName = Object.fromEntries(prepared.nodes
		.filter((node) => node.type === NodeType.SVG_PATH)
		.map((node) => [node.name, node.id]));

	Object.assign(document.nodes[byName[want]], placement);

	const made = prepareJob(project, [byName[want]], { newId, fields: { cutDepth: 1 } });
	Object.assign(project.geometry, made.geometry);

	const tool = createNode(NodeType.TOOL, { name: 'Bit' }, { newId });
	tool.children = [made.job.id];
	document.nodes[tool.id] = tool;
	document.nodes[made.job.id] = made.job;
	folderOf(document, FolderRole.JOBS).children.push(tool.id);

	return { project, document, job: made.job, made, byName, docId: prepared.doc.id };
}

/** The bounding box of a job's toolpath. */
function cutBox(f) {
	const points = generateJobToolpath(f.project, f.job.id).paths.flatMap((path) => path.points);
	const xs = points.map((point) => point[0]);
	const ys = points.map((point) => point[1]);
	return { minX: Math.min(...xs), minY: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs) };
}


describe('a job owns a copy of the outline', () => {

	it('has its own geometry, not the path’s', () => {
		const f = fixture();
		expect(f.job.geometry).not.toBe(f.document.nodes[f.byName.plate].geometry);
		expect(outlineOf(f.project, f.job.id).total).toBe(1);
	});

	it('shares nothing with the original, so neither can corrupt the other', () => {

		// A shallow copy would pass every other test in this file and then quietly
		// let an edit to the drawing reach into the job's geometry.
		const f = fixture();
		const mine = f.project.geometry[f.job.geometry].subPaths;
		const theirs = f.project.geometry[f.document.nodes[f.byName.plate].geometry].subPaths;

		expect(mine[0]).not.toBe(theirs[0]);
		expect(mine[0].segments[0]).not.toBe(theirs[0].segments[0]);
		expect(mine[0].segments[0].to).not.toBe(theirs[0].segments[0].to);
	});

	it('records where it came from, as a note rather than a link', () => {
		const f = fixture();
		expect(f.job.source).toEqual([f.byName.plate]);
	});

	it('takes the path’s name', () => {
		expect(fixture().job.name).toBe('plate');
	});
});


describe('independence from the drawing, which is the whole point', () => {

	it('cuts the same thing after the path is HIDDEN', () => {
		const f = fixture();
		const before = cutBox(f);
		f.document.nodes[f.byName.plate].visible = false;
		expect(cutBox(f)).toEqual(before);
	});

	it('cuts the same thing after the path is MOVED', () => {

		// Under the old model this moved the cut, which is exactly what Greg
		// objected to: the job followed the drawing around instead of being a
		// thing in its own right.
		const f = fixture();
		const before = cutBox(f);
		f.document.nodes[f.byName.plate].offset = { x: 250, y: 250 };
		expect(cutBox(f)).toEqual(before);
	});

	it('cuts the same thing after the path is SCALED', () => {
		const f = fixture();
		const before = cutBox(f);
		f.document.nodes[f.byName.plate].scale = { x: 3, y: 3 };
		expect(cutBox(f)).toEqual(before);
	});

	it('cuts the same thing after the whole drawing is DELETED', () => {

		// The strongest form of the claim, and the one that would have been
		// impossible before: no path node, no drawing node, no drawing geometry.
		const f = fixture();
		const before = cutBox(f);

		delete f.project.geometry[f.document.nodes[f.byName.plate].geometry];
		delete f.document.nodes[f.byName.plate];
		delete f.document.nodes[f.byName.zigzag];
		delete f.document.nodes[f.docId];
		folderOf(f.document, FolderRole.SVGS).children = [];

		expect(cutBox(f)).toEqual(before);
		expect(diagnose(f.project).filter((d) => d.nodeId === f.job.id && d.level === 'error'))
			.toEqual([]);
	});
});


describe('“it should appear exactly where the path was”', () => {

	it('starts unplaced when the path was', () => {
		// `offset` is not an inherited field, so `createNode` writes its default
		// rather than leaving it absent — unmoved, explicitly
		const f = fixture();
		expect(f.job.offset).toEqual({ x: 0, y: 0 });
		expect(f.job.rotation).toBe(0);
		expect(f.job.scale).toEqual({ x: 1, y: 1 });
	});

	it('takes on the path’s position, so the job lands on top of it', () => {

		const plain = fixture();
		const moved = fixture('plate', { offset: { x: 30, y: -12 } });

		expect(moved.job.offset.x).toBeCloseTo(30, 9);
		expect(moved.job.offset.y).toBeCloseTo(-12, 9);

		// and the CUT is in the same place the moved path was, not the origin
		expect(cutBox(moved).minX - cutBox(plain).minX).toBeCloseTo(30, 6);
	});

	it('takes on the path’s rotation and scale too', () => {

		const turned = fixture('plate', { rotation: Math.PI / 2, scale: { x: 2, y: 2 } });

		expect(turned.job.rotation).toBeCloseTo(Math.PI / 2, 9);
		expect(turned.job.scale.x).toBeCloseTo(2, 9);

		// 60 x 40 doubled is 120 x 80; turned a quarter it is 80 wide. The default
		// operation is centre, so the toolpath IS the outline and there is no kerf
		// offset to add — which is also the cleanest possible check that the
		// rotation and the scale both came across.
		expect(cutBox(turned).width).toBeCloseTo(80, 6);
	});

	it('moves with its OWN placement afterwards, not the path’s', () => {

		const f = fixture();
		const before = cutBox(f);

		f.document.nodes[f.job.id].offset = { x: 40, y: 0 };

		expect(cutBox(f).minX - before.minX).toBeCloseTo(40, 6);
	});
});


describe('several paths at once', () => {

	it('merges every outline into one job', () => {

		const newId = counter();
		const project = createProject({ newId });
		const prepared = prepareSvgImport(SVG, { filename: 'a.svg', newId });
		Object.assign(project.geometry, prepared.geometry);
		for (const node of prepared.nodes)
			project.document.nodes[node.id] = node;

		const ids = prepared.nodes.filter((n) => n.type === NodeType.SVG_PATH).map((n) => n.id);
		const made = prepareJob(project, ids, { newId });
		Object.assign(project.geometry, made.geometry);
		project.document.nodes[made.job.id] = made.job;

		expect(outlineOf(project, made.job.id).total).toBe(2);
		expect(made.job.name).toBe('2 paths');
	});

	it('refuses to guess when the paths are placed differently, and says so', () => {

		// Taking on ONE of several placements would move the others. Leaving the
		// copy where it already is at least keeps the shapes in the right
		// relationship to each other.
		const newId = counter();
		const project = createProject({ newId });
		const prepared = prepareSvgImport(SVG, { filename: 'a.svg', newId });
		Object.assign(project.geometry, prepared.geometry);
		for (const node of prepared.nodes)
			project.document.nodes[node.id] = node;

		const ids = prepared.nodes.filter((n) => n.type === NodeType.SVG_PATH).map((n) => n.id);
		project.document.nodes[ids[0]].offset = { x: 50, y: 0 };

		const made = prepareJob(project, ids, { newId });

		expect(made.job.offset).toEqual({ x: 0, y: 0 });
		expect(made.warnings.join(' ')).toMatch(/placed differently/);
	});
});


describe('reading the outline instead of a stored flag', () => {

	it('counts open and closed subpaths from the geometry itself', () => {
		expect(outlineOf(fixture('plate').project, fixture('plate').job.id))
			.toEqual({ total: 1, closed: 1, open: 0 });
		expect(outlineOf(fixture('zigzag').project, fixture('zigzag').job.id))
			.toEqual({ total: 1, closed: 0, open: 1 });
	});

	it('blocks a closed operation on an open outline, and names the operation', () => {

		// Greg's report: an open path was offered inside/outside/pocket and quietly
		// produced a closed-looking result. The diagnostic now comes off the job's
		// own subpaths rather than off an aggregate flag on the drawing.
		const f = fixture('zigzag');
		f.document.nodes[f.job.id].operation = 'outside';

		const found = diagnose(f.project)
			.filter((d) => d.code === 'operation-mismatch' && d.nodeId === f.job.id);

		expect(found).toHaveLength(1);
		expect(found[0].level).toBe('error');
		expect(found[0].message).toMatch(/needs a closed path/);
	});

	it('is happy with an open outline on an open operation', () => {
		const f = fixture('zigzag');
		f.document.nodes[f.job.id].operation = 'normal';
		expect(diagnose(f.project).filter((d) => d.code === 'operation-mismatch')).toEqual([]);
	});

	it('says a job with no outline has nothing to cut', () => {
		const f = fixture();
		delete f.project.geometry[f.job.geometry];
		expect(diagnose(f.project).some((d) => d.code === 'job-empty')).toBe(true);
	});
});
