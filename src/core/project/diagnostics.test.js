import { describe, it, expect } from 'vitest';

import { NodeType, FolderRole, JobOperation, createNode } from './nodes.js';
import { createProject } from './document.js';
import { folderOf } from './tree.js';
import { prepareJob } from './jobs.js';
import { normalizePathData } from '../path/normalize.js';
import { Level, DepthClass, classifyDepth, diagnose, blocksExport, byNode } from './diagnostics.js';

/** Deterministic ids. */
const counter = () => { let n = 0; return () => `n${(n += 1)}`; };

/**
 * The drawing's two paths: a bent line that stays open, and a closed triangle.
 *
 * Real path data rather than a hand-written `closed` flag, because the whole
 * point of the operation checks is that they count the SUBPATHS of the job's own
 * outline rather than trusting a flag that could disagree with the shape.
 */
const SHAPES = Object.freeze({
	open: 'M0 0 L10 0 L10 10',
	closed: 'M0 0 L10 0 L10 10 Z',
});

/**
 * A project with one tool and one job whose outline is copied from one open path.
 *
 * The job is built by `prepareJob` and the geometry it returns is merged into the
 * store, exactly as the application does it — a job owns its outline now, so a
 * fixture that only pointed at a path would be describing a model that is gone.
 *
 * @param {Object} [job] - fields to set on the job
 * @param {Object} [projectFields] - fields to set on the project
 * @param {String[]} [sources] - which of the drawing's paths, by name, the job's
 *   outline is copied from
 * @returns {Object} `{ project, document, newId, n }`
 */
function fixture(job = {}, projectFields = {}, sources = ['open']) {

	const newId = counter();
	const built = createProject({ name: 'Test', newId });
	const document = built.document;
	const put = (parentId, node) => {
		document.nodes[node.id] = node;
		document.nodes[parentId].children.push(node.id);
		return node;
	};

	Object.assign(document.nodes[document.root], projectFields);

	const doc = put(folderOf(document, FolderRole.SVGS).id,
		createNode(NodeType.SVG_DOC, { name: 'a.svg' }, { newId }));
	const open = put(doc.id, createNode(NodeType.SVG_PATH,
		{ name: 'open', closed: false, geometry: 'g-open' }, { newId }));
	const closed = put(doc.id, createNode(NodeType.SVG_PATH,
		{ name: 'closed', closed: true, geometry: 'g-closed' }, { newId }));

	built.geometry['g-open'] = { subPaths: normalizePathData(SHAPES.open).subPaths };
	built.geometry['g-closed'] = { subPaths: normalizePathData(SHAPES.closed).subPaths };

	const tool = put(folderOf(document, FolderRole.JOBS).id,
		createNode(NodeType.TOOL, { name: 'Bit' }, { newId }));

	const byName = { open, closed };
	const made = prepareJob(built, sources.map((name) => byName[name].id),
		{ newId, name: 'Cut', fields: job });
	const j = put(tool.id, made.job);

	Object.assign(built.geometry, made.geometry);

	return { project: built, document, newId, n: { doc, open, closed, tool, j } };
}

/**
 * Rebuilds a fixture's job so it owns a copy of the given paths' outlines.
 *
 * The same route the application takes when a job is made, used here because the
 * old model let a test simply repoint `paths` at another node.
 *
 * @param {Object} context - a fixture
 * @param {String[]} pathIds - the SvgPath nodes to copy from
 * @returns {void}
 */
function remake(context, pathIds) {

	const { project, document, newId, n } = context;
	const made = prepareJob(project, pathIds, { newId });

	Object.assign(project.geometry, made.geometry);
	Object.assign(document.nodes[n.j.id], {
		geometry: made.job.geometry,
		source: made.job.source,
		offset: made.job.offset,
		rotation: made.job.rotation,
		scale: made.job.scale,
	});
}

/** Codes reported, for terse assertions. */
const codes = (project) => diagnose(project).map((d) => d.code);

/** One diagnostic by code. */
const find = (project, code) => diagnose(project).find((d) => d.code === code);


describe('classifying a cut depth', () => {

	it('calls a shallow cut a groove, and says how much is left', () => {
		expect(classifyDepth(1, 4, 1)).toMatchObject({ depthClass: DepthClass.GROOVE, remaining: 3 });
	});

	it('calls a cut that reaches the bottom a through cut', () => {
		expect(classifyDepth(4, 4, 1).depthClass).toBe(DepthClass.THROUGH);
		expect(classifyDepth(5, 4, 1).depthClass).toBe(DepthClass.THROUGH);
	});

	it('calls anything past the allowance beyond, and says how far', () => {
		expect(classifyDepth(6, 4, 1)).toMatchObject({ depthClass: DepthClass.BEYOND, past: 1 });
	});

	it('measures against machine resolution, not float precision', () => {
		// rule 6: a hobby router does not resolve a thousandth of a millimetre,
		// so 4mm minus a rounding error IS 4mm and must not read as a groove
		expect(classifyDepth(4 - 1e-9, 4, 1).depthClass).toBe(DepthClass.THROUGH);
		expect(classifyDepth(5 + 1e-9, 4, 1).depthClass).toBe(DepthClass.THROUGH);
		expect(classifyDepth(3.99, 4, 1).depthClass).toBe(DepthClass.GROOVE);
	});
});


describe('what a job does to the stock', () => {

	it('states a groove as a fact, never as a problem', () => {
		// D17: the kerf is the artwork. A cut that does not go through is most of
		// what this program is for, and flagging it teaches you to ignore flags
		const { project } = fixture({ cutDepth: 1 });
		const said = find(project, 'depth-groove');

		expect(said.level).toBe(Level.INFO);
		expect(said.message).toBe('Cuts 1.00mm of 4.00mm — 3.00mm left below.');
	});

	it('states a through cut the same way', () => {
		const { project } = fixture({ cutDepth: 5 });

		expect(find(project, 'depth-through')).toMatchObject({ level: Level.INFO });
	});

	it('warns only when the cut is past the allowance, into the spoilboard', () => {
		const { project } = fixture({ cutDepth: 9 });
		const said = find(project, 'depth-beyond');

		expect(said.level).toBe(Level.WARNING);
		expect(said.message).toMatch(/4\.00mm deeper/);
	});

	it('is how a change of material becomes visible, without anything shouting', () => {
		// Greg's call: cut depth is an explicit number and nothing recalculates
		// it. So the job that read "through" now reads "13mm left", and that
		// sentence changing is the whole notification mechanism
		const before = fixture({ cutDepth: 5 }, { materialThickness: 4 });
		expect(find(before.project, 'depth-through')).toBeDefined();

		const after = fixture({ cutDepth: 5 }, { materialThickness: 18 });
		expect(find(after.project, 'depth-groove').message).toContain('13.00mm left');
		expect(codes(after.project)).not.toContain('depth-beyond');
	});
});


describe('things it deliberately stays quiet about', () => {

	it('says nothing about a through cut with no tabs', () => {
		// both halves may be clamped. "Is the part held" is the wrong question
		// when nothing is being cut free (D17)
		const { project } = fixture({ cutDepth: 5 });

		expect(codes(project).filter((code) => /tab/.test(code))).toEqual([]);
		expect(blocksExport(diagnose(project))).toBe(false);
	});

	it('says nothing about a pass depth larger than the cut depth', () => {
		const { project, document, n } = fixture({ cutDepth: 1 });
		document.nodes[n.j.id].passDepth = 10;

		expect(codes(project).filter((code) => /pass/.test(code))).toEqual([]);
	});

	it('says nothing about detail finer than the bit', () => {
		const { project } = fixture();

		expect(codes(project).some((code) => /detail|fine|small/.test(code))).toBe(false);
	});
});


describe('things that stop a program being emitted', () => {

	it('a job with no paths', () => {
		const { project } = fixture({}, {}, []);

		expect(find(project, 'job-empty').level).toBe(Level.ERROR);
		expect(blocksExport(diagnose(project))).toBe(true);
	});

	it('an operation that needs a closed path, on an open one', () => {
		const { project } = fixture({ operation: JobOperation.POCKET });
		const said = find(project, 'operation-mismatch');

		expect(said.level).toBe(Level.ERROR);
		expect(said.message).toMatch(/needs a closed path/);
	});

	it('warns rather than blocking when only some of a mixed selection is wrong', () => {
		const context = fixture({ operation: JobOperation.POCKET });
		remake(context, [context.n.open.id, context.n.closed.id]);

		expect(find(context.project, 'operation-mismatch')).toMatchObject({ level: Level.WARNING });
		expect(blocksExport(diagnose(context.project))).toBe(false);
	});

	it('says nothing when the operation suits the paths', () => {
		const context = fixture({ operation: JobOperation.HEADING });
		expect(codes(context.project)).not.toContain('operation-mismatch');

		remake(context, [context.n.closed.id]);
		context.document.nodes[context.n.j.id].operation = JobOperation.INSIDE;
		expect(codes(context.project)).not.toContain('operation-mismatch');
	});

	it('a centre cut is fine on either, because it means the same thing on both', () => {
		const context = fixture({ operation: JobOperation.CENTER });
		remake(context, [context.n.open.id, context.n.closed.id]);

		expect(codes(context.project)).not.toContain('operation-mismatch');
	});

	it('a safe Z that is not above the surface', () => {
		const { project } = fixture({}, { safeZ: 0 });

		expect(find(project, 'safe-z').level).toBe(Level.ERROR);
	});

	it('a cut the machine cannot physically reach', () => {
		// safe Z plus cut depth is the SPAN the spindle has to cover, so it is a
		// limit wherever the work zero happens to be set
		const { project } = fixture({ cutDepth: 74 }, { safeZ: 5, zTravel: 75, materialThickness: 80 });
		const said = find(project, 'z-travel');

		expect(said.level).toBe(Level.ERROR);
		expect(said.message).toMatch(/needs 79\.00mm of Z travel.*machine has 75\.00mm/);
	});

	it('is quiet when the cut fits, right up to the last tenth', () => {
		const { project } = fixture({ cutDepth: 70 }, { safeZ: 5, zTravel: 75, materialThickness: 80 });

		expect(codes(project)).not.toContain('z-travel');
	});

	it('a tool with no cutting diameter', () => {
		const { project, document, n } = fixture();
		document.nodes[n.tool.id].diameter = 0;

		expect(find(project, 'tool-diameter').level).toBe(Level.ERROR);
	});
});


describe('tabs', () => {

	/**
	 * Adds a tab to the job.
	 *
	 * @param {Object} context - a fixture
	 * @param {Object} fields - the tab's fields
	 * @returns {Object} the tab node
	 */
	const addTab = ({ document, newId, n }, fields) => {
		const tab = createNode(NodeType.TAB, fields, { newId });
		document.nodes[tab.id] = tab;
		document.nodes[n.j.id].children.push(tab.id);
		return tab;
	};

	it('warns when a tab is as deep as the cut, so it breaks nothing', () => {
		const context = fixture({ cutDepth: 5 });
		addTab(context, { name: 'Deep', position: 10, depth: 5 });

		expect(find(context.project, 'tab-no-effect').level).toBe(Level.WARNING);
	});

	it('is quiet about a tab that leaves the material completely intact', () => {
		// depth 0 is the default and exactly what Greg asked for
		const context = fixture({ cutDepth: 5 });
		addTab(context, { name: 'Full', position: 10, depth: 0 });

		expect(codes(context.project)).not.toContain('tab-no-effect');
	});

	it('warns when two tabs run into each other', () => {
		const context = fixture({ cutDepth: 5 });
		addTab(context, { name: 'One', position: 10, length: 6 });
		addTab(context, { name: 'Two', position: 13, length: 6 });

		expect(find(context.project, 'tab-overlap').message).toMatch(/overlaps One/);
	});

	it('is quiet about tabs that merely sit near each other', () => {
		const context = fixture({ cutDepth: 5 });
		addTab(context, { name: 'One', position: 10, length: 6 });
		addTab(context, { name: 'Two', position: 17, length: 6 });

		expect(codes(context.project)).not.toContain('tab-overlap');
	});

	it('follows the project default depth, so retuning one number retunes them all', () => {
		const context = fixture({ cutDepth: 5 }, { defaultTabDepth: 5 });
		addTab(context, { name: 'Inherits', position: 10 });

		expect(find(context.project, 'tab-no-effect')).toBeDefined();
	});
});


describe('reporting', () => {

	it('groups by node, which is what the outliner badges from', () => {
		const { project, n } = fixture({ cutDepth: 9 });
		const grouped = byNode(diagnose(project));

		expect(grouped.get(n.j.id).map((d) => d.code)).toEqual(['depth-beyond']);
	});

	it('mentions an empty tool without complaining about it', () => {
		const { project, document, newId } = fixture();
		const tool = createNode(NodeType.TOOL, { name: 'Unused' }, { newId });
		document.nodes[tool.id] = tool;
		document.nodes[folderOf(document, FolderRole.JOBS).id].children.push(tool.id);

		expect(find(project, 'tool-empty').level).toBe(Level.INFO);
		expect(blocksExport(diagnose(project))).toBe(false);
	});

	it('has something to say about a project with no jobs at all: nothing', () => {
		const project = createProject({ newId: counter() });

		expect(diagnose(project)).toEqual([]);
	});
});
