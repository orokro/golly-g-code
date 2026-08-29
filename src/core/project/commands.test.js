import { describe, it, expect } from 'vitest';

import { NodeType, FolderRole, createNode } from './nodes.js';
import { createProject } from './document.js';
import { folderOf, childrenOf, validateTree, cuttingOrder } from './tree.js';
import { resolveField, Source } from './inherit.js';
import { createHistory } from './history.js';
import { nodeDriver, cloneState, diffStates } from './snapshot.js';
import {
	setField, clearOverride, addNode, removeNode, moveNode, reorderChildren, setReferences,
} from './commands.js';

/** Deterministic ids. */
const counter = () => { let n = 0; return () => `n${(n += 1)}`; };

/**
 * A project with two tools, jobs under each, an svg with two paths, and a tab.
 *
 * @returns {Object} `{ project, document, h, n }`
 */
function fixture() {

	const newId = counter();
	const project = createProject({ name: 'Test', newId });
	const document = project.document;
	const put = (parentId, node) => {
		document.nodes[node.id] = node;
		document.nodes[parentId].children.push(node.id);
		return node;
	};

	const jobs = folderOf(document, FolderRole.JOBS);
	const svgs = folderOf(document, FolderRole.SVGS);

	const doc = put(svgs.id, createNode(NodeType.SVG_DOC, { name: 'skyline.svg' }, { newId }));
	const open = put(doc.id, createNode(NodeType.SVG_PATH, { name: 'skyline', closed: false }, { newId }));
	const closed = put(doc.id, createNode(NodeType.SVG_PATH, { name: 'plate', closed: true }, { newId }));
	const spareP = put(doc.id, createNode(NodeType.SVG_PATH, { name: 'holes', closed: true }, { newId }));

	const tool = put(jobs.id, createNode(NodeType.TOOL, { name: '1/8 flat' }, { newId }));
	const spare = put(jobs.id, createNode(NodeType.TOOL, { name: '1/4 flat', diameter: 6.35 }, { newId }));
	const a = put(tool.id, createNode(NodeType.JOB, { name: 'Skyline', paths: [open.id] }, { newId }));
	const b = put(tool.id, createNode(NodeType.JOB, { name: 'Plate', paths: [closed.id] }, { newId }));
	const tab = put(a.id, createNode(NodeType.TAB, { name: 'Tab 1', position: 20 }, { newId }));

	// verify on: every dispatch checks that the command changed only what it
	// declared. That is the whole reason these tests run through a real history
	// rather than calling apply by hand
	const h = createHistory({ driver: nodeDriver, verify: true });

	return { project, document, h, newId, n: { jobs, svgs, doc, open, closed, spareP, tool, spare, a, b, tab } };
}


describe('setting a field', () => {

	it('changes it, and undoes', () => {
		const { document, h, n } = fixture();

		h.dispatch(document, setField(document, n.a.id, 'cutDepth', 5));
		expect(document.nodes[n.a.id].cutDepth).toBe(5);

		h.undo(document);
		expect(document.nodes[n.a.id].cutDepth).toBe(1);
	});

	it('collapses a drag into one entry, per node and field', () => {
		const { document, h, n } = fixture();

		for (const depth of [2, 3, 4, 5])
			h.dispatch(document, setField(document, n.a.id, 'cutDepth', depth));

		expect(h.depth().past).toBe(1);

		h.dispatch(document, setField(document, n.a.id, 'margin', 1));
		h.dispatch(document, setField(document, n.b.id, 'cutDepth', 9));
		expect(h.depth().past).toBe(3);
	});

	it('takes a deliberate single change out of the coalescing', () => {
		const { document, h, n } = fixture();

		h.dispatch(document, setField(document, n.a.id, 'cutDepth', 2, { coalesce: false }));
		h.dispatch(document, setField(document, n.a.id, 'cutDepth', 3, { coalesce: false }));

		expect(h.depth().past).toBe(2);
	});

	it('refuses a bad value before it can enter the undo stack', () => {
		// a rejected value that reached the stack would be reachable again by
		// undoing back through it, which is worse than never accepting it
		const { document, h, n } = fixture();

		expect(() => setField(document, n.tool.id, 'stepover', 1.5)).toThrow(/Stepover/);
		expect(() => setField(document, n.a.id, 'cutDepth', NaN)).toThrow();
		expect(() => setField(document, n.a.id, 'direction', 'sideways')).toThrow();
		expect(h.canUndo()).toBe(false);
	});

	it('refuses a field the node does not have', () => {
		const { document, n } = fixture();

		expect(() => setField(document, n.tab.id, 'cutFeed', 100)).toThrow(/Tab has no field/);
	});
});


describe('overriding and un-overriding', () => {

	it('restores the LINK, not the value it happened to have', () => {
		// the difference that only shows up later: after resetting, correcting
		// the tool must move the job again
		const { document, h, n } = fixture();

		h.dispatch(document, setField(document, n.tool.id, 'cutFeed', 650));
		h.dispatch(document, setField(document, n.a.id, 'cutFeed', 400));

		expect(resolveField(document, n.a.id, 'cutFeed')).toMatchObject({ value: 400, source: Source.OWN });

		h.dispatch(document, clearOverride(document, n.a.id, 'cutFeed'));
		h.dispatch(document, setField(document, n.tool.id, 'cutFeed', 900));

		expect(resolveField(document, n.a.id, 'cutFeed'))
			.toMatchObject({ value: 900, source: Source.INHERITED, from: n.tool.id });
	});

	it('undoes back to the override, key and all', () => {
		const { document, h, n } = fixture();

		h.dispatch(document, setField(document, n.a.id, 'cutFeed', 400));
		h.dispatch(document, clearOverride(document, n.a.id, 'cutFeed'));
		expect('cutFeed' in document.nodes[n.a.id]).toBe(false);

		h.undo(document);
		expect(document.nodes[n.a.id].cutFeed).toBe(400);
	});

	it('refuses a field that has no link to restore', () => {
		const { document, n } = fixture();

		expect(() => clearOverride(document, n.a.id, 'cutDepth')).toThrow(/not an inheritable field/);
	});
});


describe('adding and removing', () => {

	it('adds, selects, and undoes both', () => {
		const { document, h, n, newId } = fixture();
		const job = createNode(NodeType.JOB, { name: 'New' }, { newId });

		h.dispatch(document, addNode(document, n.tool.id, job));

		expect(childrenOf(document, n.tool.id).map((x) => x.name)).toEqual(['Skyline', 'Plate', 'New']);
		expect(document.selection.active).toBe(job.id);

		h.undo(document);
		expect(document.nodes[job.id]).toBeUndefined();
		expect(document.selection.active).toBe(document.root);
	});

	it('adds at a position when asked', () => {
		const { document, h, n, newId } = fixture();

		h.dispatch(document, addNode(document, n.tool.id,
			createNode(NodeType.JOB, { name: 'First' }, { newId }), { index: 0 }));

		expect(childrenOf(document, n.tool.id).map((x) => x.name)).toEqual(['First', 'Skyline', 'Plate']);
	});

	it('removes a subtree and brings all of it back', () => {
		const { document, h, n } = fixture();

		h.dispatch(document, removeNode(document, n.a.id));

		expect(document.nodes[n.a.id]).toBeUndefined();
		expect(document.nodes[n.tab.id]).toBeUndefined();
		expect(validateTree(document)).toEqual([]);

		h.undo(document);
		expect(document.nodes[n.tab.id].position).toBe(20);
		expect(childrenOf(document, n.tool.id).map((x) => x.name)).toEqual(['Skyline', 'Plate']);
	});

	it('cleans up references to what it deleted, and says that it will', () => {
		// the subtle one. Deleting a path writes to the JOB that cut it, which is
		// outside the deleted subtree -- so the job has to be in touches. Getting
		// this wrong is caught by verify, which is how it was found
		const { document, h, n } = fixture();

		const command = removeNode(document, n.open.id);
		expect(command.touches).toContain(n.a.id);

		h.dispatch(document, command);
		expect(document.nodes[n.a.id].paths).toEqual([]);
		expect(validateTree(document)).toEqual([]);

		h.undo(document);
		expect(document.nodes[n.a.id].paths).toEqual([n.open.id]);
	});

	it('does not leave the selection pointing at something deleted', () => {
		const { document, h, n } = fixture();

		h.dispatch(document, setField(document, n.tab.id, 'position', 30));
		document.selection = { active: n.tab.id, ids: [n.tab.id] };

		h.dispatch(document, removeNode(document, n.a.id));

		expect(document.nodes[document.selection.active]).toBeDefined();
		expect(document.selection.active).toBe(n.tool.id);
		expect(validateTree(document)).toEqual([]);
	});

	it('will not remove the project itself', () => {
		const { document } = fixture();

		expect(() => removeNode(document, document.root)).toThrow(/cannot be removed/);
	});
});


describe('moving and reordering', () => {

	it('moves a job to the other tool, and back', () => {
		const { document, h, n } = fixture();

		h.dispatch(document, moveNode(document, n.b.id, n.spare.id));

		expect(cuttingOrder(document).map((x) => `${x.tool.name}/${x.job.name}`))
			.toEqual(['1/8 flat/Skyline', '1/4 flat/Plate']);

		h.undo(document);
		expect(cuttingOrder(document).map((x) => x.job.name)).toEqual(['Skyline', 'Plate']);
	});

	it('reorders within one parent, which IS the cutting order', () => {
		const { document, h, n } = fixture();

		h.dispatch(document, moveNode(document, n.b.id, n.tool.id, 0));
		expect(cuttingOrder(document).map((x) => x.job.name)).toEqual(['Plate', 'Skyline']);

		h.dispatch(document, reorderChildren(document, n.tool.id, [n.a.id, n.b.id]));
		expect(cuttingOrder(document).map((x) => x.job.name)).toEqual(['Skyline', 'Plate']);
	});

	it('refuses to move a node into its own subtree', () => {
		const { document, n } = fixture();

		expect(() => moveNode(document, n.tool.id, n.a.id)).toThrow(/into itself/);
	});

	it('refuses a reorder that is not the same set of children', () => {
		const { document, n } = fixture();

		expect(() => reorderChildren(document, n.tool.id, [n.a.id])).toThrow(/exactly the same children/);
		expect(() => reorderChildren(document, n.tool.id, [n.a.id, n.b.id, n.tab.id]))
			.toThrow(/exactly the same children/);
	});
});


describe('references', () => {

	it('points a job at other paths, and undoes', () => {
		const { document, h, n } = fixture();

		h.dispatch(document, setReferences(document, n.a.id, 'paths', [n.open.id, n.closed.id]));
		expect(document.nodes[n.a.id].paths).toHaveLength(2);

		h.undo(document);
		expect(document.nodes[n.a.id].paths).toEqual([n.open.id]);
	});

	it('refuses to point at something that is not there', () => {
		const { document, n } = fixture();

		expect(() => setReferences(document, n.a.id, 'paths', ['ghost'])).toThrow(/not in the document/);
	});

	it('refuses a field that is not a reference list', () => {
		const { document, n } = fixture();

		expect(() => setReferences(document, n.a.id, 'cutDepth', [])).toThrow(/not a reference list/);
	});
});


describe('a session of random project edits', () => {

	/**
	 * A small deterministic PRNG.
	 *
	 * @param {Number} seed - the seed
	 * @returns {Function} a float in [0, 1)
	 */
	function random(seed) {
		let t = seed >>> 0;
		return () => {
			t = (t + 0x6d2b79f5) >>> 0;
			let x = Math.imul(t ^ (t >>> 15), 1 | t);
			x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
			return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
		};
	}

	/**
	 * Invents a real command against the real model.
	 *
	 * @param {Object} document - the document
	 * @param {Object} n - the named fixture nodes
	 * @param {Function} rand - the PRNG
	 * @param {Function} newId - id factory
	 * @returns {Object|null} a command, or null when nothing applies
	 */
	function invent(document, n, rand, newId) {

		const pick = (list) => list[Math.floor(rand() * list.length)];
		const tools = [n.tool.id, n.spare.id].filter((id) => document.nodes[id] !== undefined);
		const jobs = tools.flatMap((id) => document.nodes[id].children);
		const paths = [n.open.id, n.closed.id, n.spareP.id].filter((id) => document.nodes[id] !== undefined);
		const roll = rand();

		// Deleting a PATH is the case that makes a command write outside its own
		// subtree, because every job cutting it has to lose the reference. Left
		// out of the first version of this, and the result was that dropping the
		// referrers from `touches` failed exactly one hand-written test.
		if (roll < 0.08 && paths.length > 1)
			return removeNode(document, pick(paths));

		if (roll < 0.16 && jobs.length > 0 && paths.length > 0)
			return setReferences(document, pick(jobs), 'paths',
				paths.filter(() => rand() < 0.6));

		if (roll < 0.25 && tools.length > 0)
			return addNode(document, pick(tools), createNode(NodeType.JOB, { name: 'J' }, { newId }));

		if (jobs.length === 0)
			return null;

		const job = pick(jobs);

		if (roll < 0.4)
			return addNode(document, job, createNode(NodeType.TAB, { name: 'T', position: rand() * 50 }, { newId }));

		if (roll < 0.55 && jobs.length > 1)
			return removeNode(document, job);

		if (roll < 0.7 && tools.length > 1)
			return moveNode(document, job, pick(tools), Math.floor(rand() * 3));

		if (roll < 0.8)
			return clearOverride(document, job, pick(['cutFeed', 'passDepth', 'spindleRpm']));

		if (roll < 0.9)
			return setField(document, job, 'cutFeed', 200 + Math.round(rand() * 800));

		return setField(document, pick(tools), 'cutFeed', 200 + Math.round(rand() * 800));
	}

	it('stays structurally sound the whole way, and comes all the way back', () => {
		for (let seed = 1; seed <= 25; seed += 1) {

			const { document, h, n, newId } = fixture();
			const start = cloneState(document);

			for (let i = 0; i < 50; i += 1) {

				const command = invent(document, n, random(seed + (i * 7919)), newId);

				if (command === null)
					continue;

				h.dispatch(document, command);

				// after EVERY command, not just at the end: a shape broken in the
				// middle and repaired by luck is still a broken command
				expect(validateTree(document), `seed ${seed}, step ${i}`).toEqual([]);
			}

			const ending = cloneState(document);

			while (h.canUndo())
				h.undo(document);

			expect(diffStates(start, document), `seed ${seed}, undone`).toEqual([]);

			while (h.canRedo())
				h.redo(document);

			expect(diffStates(ending, document), `seed ${seed}, redone`).toEqual([]);
		}
	});
});
