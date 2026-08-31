import { describe, it, expect } from 'vitest';

import { NodeType, FolderRole, createNode } from '@core/project/nodes.js';
import { createProject } from '@core/project/document.js';
import { folderOf, parentOf, validateTree } from '@core/project/tree.js';
import { createHistory } from '@core/project/history.js';
import { nodeDriver } from '@core/project/snapshot.js';
import { moveNode } from '@core/project/commands.js';
import { diagnose, byNode } from '@core/project/diagnostics.js';

import {
	Drop, SPLIT_FRACTION, flattenTree, canDropInto, resolveDrop,
	adjustedIndex, rangeBetween, clickSelection, detailLine, detailTitle,
} from './rows.js';

/** Deterministic ids. */
const counter = () => { let k = 0; return () => `n${(k += 1)}`; };

/**
 * A project with two tools, three jobs, a tab, and an SVG with two paths.
 *
 * @returns {Object} `{ project, document, n }`
 */
function fixture() {

	const newId = counter();
	const project = createProject({ name: 'P', newId });
	const document = project.document;
	const put = (parentId, node) => {
		document.nodes[node.id] = node;
		document.nodes[parentId].children.push(node.id);
		return node;
	};

	const jobs = folderOf(document, FolderRole.JOBS);
	const svgs = folderOf(document, FolderRole.SVGS);
	const refs = folderOf(document, FolderRole.REFERENCES);

	const doc = put(svgs.id, createNode(NodeType.SVG_DOC, { name: 'a.svg' }, { newId }));
	const p1 = put(doc.id, createNode(NodeType.SVG_PATH, { name: 'p1', closed: true }, { newId }));
	const p2 = put(doc.id, createNode(NodeType.SVG_PATH, { name: 'p2', closed: false }, { newId }));

	const tool = put(jobs.id, createNode(NodeType.TOOL, { name: 'T1' }, { newId }));
	const spare = put(jobs.id, createNode(NodeType.TOOL, { name: 'T2' }, { newId }));
	const a = put(tool.id, createNode(NodeType.JOB, { name: 'A', paths: [p1.id], cutDepth: 1 }, { newId }));
	const b = put(tool.id, createNode(NodeType.JOB, { name: 'B', paths: [p1.id], cutDepth: 5 }, { newId }));
	const c = put(spare.id, createNode(NodeType.JOB, { name: 'C', paths: [p1.id] }, { newId }));
	const tab = put(a.id, createNode(NodeType.TAB, { name: 'Tab', position: 5 }, { newId }));

	return { project, document, n: { jobs, svgs, refs, doc, p1, p2, tool, spare, a, b, c, tab } };
}

/** Index of a node in a row list. */
const at = (rows, id) => rows.findIndex((row) => row.id === id);


describe('flattening the tree', () => {

	it('is the tree in display order, with indent levels', () => {
		const { document, n } = fixture();
		const rows = flattenTree(document);

		expect(rows.slice(0, 6).map((r) => `${'  '.repeat(r.depth)}${r.node.name}`)).toEqual([
			'P', '  Jobs', '    T1', '      A', '        Tab', '      B',
		]);
		// P, Jobs, T1, A, Tab, B, T2, C, SVGs, a.svg, p1, p2, References
		expect(rows.map((r) => r.node.name)).toHaveLength(13);
		expect(at(rows, n.c.id)).toBeGreaterThan(at(rows, n.spare.id));
	});

	it('hides the children of a collapsed node, and only those', () => {
		const { document, n } = fixture();
		const rows = flattenTree(document, new Set([n.tool.id]));

		expect(at(rows, n.a.id)).toBe(-1);
		expect(at(rows, n.tab.id)).toBe(-1);
		expect(at(rows, n.c.id)).toBeGreaterThan(0);
	});

	it('is expanded by default, so an import shows its paths', () => {
		// collapsed rather than expanded as the stored set: a newly imported
		// drawing has to show what came in without anything remembering to open it
		const { document, n } = fixture();

		expect(at(flattenTree(document), n.p2.id)).toBeGreaterThan(0);
	});

	it('carries inherited visibility and lock, not the node’s own flags', () => {
		const { document, n } = fixture();
		document.nodes[n.tool.id].visible = false;
		document.nodes[n.jobs.id].locked = true;

		const rows = flattenTree(document);
		const job = rows[at(rows, n.a.id)];

		expect(job.visible).toBe(false);
		expect(job.locked).toBe(true);
		expect(job.node.visible).toBe(true);
	});
});


describe('what may be dropped where', () => {

	it('follows the fixed hierarchy', () => {
		const { document, n } = fixture();

		expect(canDropInto(document, n.a.id, n.spare.id)).toBe(true);
		expect(canDropInto(document, n.a.id, n.jobs.id)).toBe(false);
		expect(canDropInto(document, n.tab.id, n.svgs.id)).toBe(false);
		expect(canDropInto(document, n.tab.id, n.b.id)).toBe(true);
	});

	it('refuses a node into its own subtree', () => {
		const { document, n } = fixture();

		expect(canDropInto(document, n.tool.id, n.a.id)).toBe(false);
		expect(canDropInto(document, n.a.id, n.a.id)).toBe(false);
	});
});


describe('where a drag lands', () => {

	/**
	 * Resolves a drop on a named row.
	 *
	 * @param {Object} context - a fixture
	 * @param {String} dragId - what is being dragged
	 * @param {String} overId - the row under the cursor
	 * @param {Number} fraction - how far down that row
	 * @returns {Object|null} the drop
	 */
	const drop = ({ document }, dragId, overId, fraction) => {
		const rows = flattenTree(document);
		return resolveDrop({ document, rows, dragId, overIndex: at(rows, overId), fraction });
	};

	it('drops INTO a row that can contain what is being dragged, wherever in it', () => {
		// a job over a tool: the tool is a container for it, and no part of the
		// row means anything else, because a job cannot be a tool's sibling
		const f = fixture();

		for (const fraction of [0, 0.1, 0.5, 0.9, 1])
			expect(drop(f, f.n.a.id, f.n.spare.id, fraction), `at ${fraction}`)
				.toMatchObject({ parentId: f.n.spare.id, kind: Drop.INTO });
	});

	it('drops BETWEEN when the cursor is near an edge', () => {
		const f = fixture();

		expect(drop(f, f.n.c.id, f.n.b.id, 0.05))
			.toMatchObject({ parentId: f.n.tool.id, index: 1, kind: Drop.BEFORE });
		expect(drop(f, f.n.c.id, f.n.b.id, 0.95))
			.toMatchObject({ parentId: f.n.tool.id, index: 2, kind: Drop.AFTER });
	});

	it('splits a row it can only be a neighbour of evenly, with no dead middle', () => {
		const f = fixture();

		expect(drop(f, f.n.c.id, f.n.b.id, SPLIT_FRACTION - 0.01))
			.toMatchObject({ parentId: f.n.tool.id, kind: Drop.BEFORE });
		expect(drop(f, f.n.c.id, f.n.b.id, SPLIT_FRACTION))
			.toMatchObject({ parentId: f.n.tool.id, kind: Drop.AFTER });
	});

	it('has NO pair for which inside and beside are both legal', () => {
		// The property the whole scheme rests on, asserted over every pair in the
		// fixture rather than reasoned about once. A three-zone drop target only
		// earns its complexity in a tree where anything can contain anything; in
		// this one it would be two dead bands on every row, which is how the
		// first version of this file ended up with a boundary test that could not
		// be made to pass.
		const f = fixture();
		const ids = Object.keys(f.document.nodes);

		for (const dragId of ids)
			for (const overId of ids) {

				const parent = parentOf(f.document, overId);

				if (parent === null)
					continue;

				const inside = canDropInto(f.document, dragId, overId);
				const beside = canDropInto(f.document, dragId, parent.id);

				expect(inside && beside,
					`${f.document.nodes[dragId].type} on ${f.document.nodes[overId].type}`).toBe(false);
			}
	});

	it('falls back to going INSIDE when it cannot be a sibling', () => {
		// dragging a tool onto the top edge of the Jobs folder means "the first
		// tool", because nothing the Jobs folder is a sibling of would take it
		const f = fixture();

		expect(drop(f, f.n.spare.id, f.n.jobs.id, 0.05))
			.toMatchObject({ parentId: f.n.jobs.id, kind: Drop.INTO });
	});

	it('refuses a drop the hierarchy does not allow', () => {
		const f = fixture();

		expect(drop(f, f.n.tab.id, f.n.doc.id, 0.5)).toBeNull();
		expect(drop(f, f.n.a.id, f.n.p1.id, 0.5)).toBeNull();
	});

	it('refuses to drop a node on itself', () => {
		const f = fixture();

		expect(drop(f, f.n.a.id, f.n.a.id, 0.5)).toBeNull();
	});

	it('refuses a drop into its own subtree, wherever in the row', () => {
		const f = fixture();

		expect(drop(f, f.n.tool.id, f.n.a.id, 0.5)).toBeNull();
	});
});


describe('the index arithmetic that makes a one-place move work', () => {

	it('shifts the index when the node is already in that parent, and is moving down', () => {
		// without this, dragging something one place down removes it before
		// reinserting it at the index it already effectively had, so nothing
		// happens and it reads as a broken drag rather than as bad arithmetic
		const { document, n } = fixture();
		const rows = flattenTree(document);
		const target = resolveDrop({
			document, rows, dragId: n.a.id, overIndex: at(rows, n.b.id), fraction: 0.95,
		});

		expect(target.index).toBe(2);
		expect(adjustedIndex(document, n.a.id, target)).toBe(1);
	});

	it('leaves the index alone when moving up, or to another parent', () => {
		const { document, n } = fixture();
		const rows = flattenTree(document);

		const up = resolveDrop({ document, rows, dragId: n.b.id, overIndex: at(rows, n.a.id), fraction: 0.05 });
		expect(adjustedIndex(document, n.b.id, up)).toBe(0);

		const across = { parentId: n.spare.id, index: 0, kind: Drop.INTO };
		expect(adjustedIndex(document, n.a.id, across)).toBe(0);
	});

	it('actually reorders when handed to the command', () => {
		const { document, n } = fixture();
		const h = createHistory({ driver: nodeDriver, verify: true });
		const rows = flattenTree(document);
		const target = resolveDrop({
			document, rows, dragId: n.a.id, overIndex: at(rows, n.b.id), fraction: 0.95,
		});

		h.dispatch(document, moveNode(document, n.a.id, target.parentId,
			adjustedIndex(document, n.a.id, target)));

		expect(document.nodes[n.tool.id].children.map((id) => document.nodes[id].name)).toEqual(['B', 'A']);
		expect(validateTree(document)).toEqual([]);

		h.undo(document);
		expect(document.nodes[n.tool.id].children.map((id) => document.nodes[id].name)).toEqual(['A', 'B']);
	});
});


describe('selecting with modifiers', () => {

	it('replaces the selection on a plain click', () => {
		const { document, n } = fixture();
		const rows = flattenTree(document);

		expect(clickSelection({ rows, selected: [n.a.id, n.b.id], anchorId: n.a.id, id: n.c.id }))
			.toEqual({ ids: [n.c.id], active: n.c.id, anchorId: n.c.id });
	});

	it('adds and removes on a ctrl click', () => {
		const { document, n } = fixture();
		const rows = flattenTree(document);

		const added = clickSelection({ rows, selected: [n.a.id], anchorId: n.a.id, id: n.b.id, toggle: true });
		expect(added.ids).toEqual([n.a.id, n.b.id]);

		const removed = clickSelection({ rows, selected: added.ids, anchorId: n.b.id, id: n.b.id, toggle: true });
		expect(removed).toMatchObject({ ids: [n.a.id], active: n.a.id });
	});

	it('never leaves nothing active while something is still selected', () => {
		const { document, n } = fixture();
		const rows = flattenTree(document);

		const result = clickSelection({
			rows, selected: [n.a.id, n.b.id], anchorId: n.a.id, id: n.a.id, toggle: true,
		});

		expect(result.ids).toEqual([n.b.id]);
		expect(result.active).toBe(n.b.id);
	});

	it('takes a shift range across the flat list, not down the tree', () => {
		// the range follows what it looks like on screen, so it crosses from a
		// job into the next tool's jobs the way the eye expects
		const { document, n } = fixture();
		const rows = flattenTree(document);

		const range = rangeBetween(rows, n.a.id, n.c.id).map((id) => document.nodes[id].name);

		expect(range).toEqual(['A', 'Tab', 'B', 'T2', 'C']);
	});

	it('takes a range in either direction', () => {
		const { document, n } = fixture();
		const rows = flattenTree(document);

		expect(rangeBetween(rows, n.c.id, n.a.id)).toEqual(rangeBetween(rows, n.a.id, n.c.id));
	});

	it('copes with an anchor that is no longer there', () => {
		const { document, n } = fixture();
		const rows = flattenTree(document);

		expect(rangeBetween(rows, 'gone', n.a.id)).toEqual([n.a.id]);
		expect(rangeBetween(rows, n.a.id, 'gone')).toEqual([]);
	});
});


describe('the second line of a job row', () => {

	it('is the depth, compactly, because the row is 170 pixels wide', () => {
		// built from the diagnostic's numbers rather than by trimming its
		// sentence, which would be parsing our own prose
		const { project, n } = fixture();
		const grouped = byNode(diagnose(project));

		expect(detailLine(project.document.nodes[n.a.id], grouped.get(n.a.id)))
			.toBe('1.00 of 4.00mm · 3.00 left');
		expect(detailLine(project.document.nodes[n.b.id], grouped.get(n.b.id)))
			.toBe('through 4.00mm · +1.00');
	});

	it('keeps the whole sentence in the tooltip', () => {
		const { project, n } = fixture();
		const grouped = byNode(diagnose(project));

		expect(detailTitle(grouped.get(n.a.id))).toBe('Cuts 1.00mm of 4.00mm — 3.00mm left below.');
	});

	it('follows a change of material, which is how the change gets noticed', () => {
		const { project, document, n } = fixture();
		document.nodes[document.root].materialThickness = 18;

		const grouped = byNode(diagnose(project));

		expect(detailLine(document.nodes[n.b.id], grouped.get(n.b.id))).toBe('5.00 of 18.00mm · 13.00 left');
	});

	it('says when a cut is past the allowance', () => {
		const { project, document, n } = fixture();
		document.nodes[n.b.id].cutDepth = 9;

		const grouped = byNode(diagnose(project));

		expect(detailLine(document.nodes[n.b.id], grouped.get(n.b.id))).toBe('4.00mm past the allowance');
	});

	it('is nothing at all for anything that is not a job', () => {
		const { document, n } = fixture();

		for (const id of [n.tool.id, n.doc.id, n.tab.id, document.root])
			expect(detailLine(document.nodes[id]), document.nodes[id].type).toBeNull();
	});
});
