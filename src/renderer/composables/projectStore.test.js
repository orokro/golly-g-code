import { describe, it, expect, vi } from 'vitest';
import { effect } from 'vue';

import { NodeType, FolderRole, createNode } from '@core/project/nodes.js';
import { createProject } from '@core/project/document.js';
import { folderOf } from '@core/project/tree.js';
import { Source } from '@core/project/inherit.js';
import { Level } from '@core/project/diagnostics.js';
import { setField, addNode, removeNode, moveNode, clearOverride } from '@core/project/commands.js';

import { createProjectStore } from './projectStore.js';

/** Deterministic ids. The prefix keeps two fixtures from minting the same ones. */
const counter = (prefix = 'n') => { let n = 0; return () => `${prefix}${(n += 1)}`; };

/**
 * A store over a project with a tool, two jobs and a path.
 *
 * @param {String} [prefix='n'] - id prefix, so two fixtures do not collide
 * @returns {Object} `{ store, n }`
 */
function fixture(prefix = 'n') {

	const newId = counter(prefix);
	const project = createProject({ name: 'Test', newId });
	const document = project.document;
	const put = (parentId, node) => {
		document.nodes[node.id] = node;
		document.nodes[parentId].children.push(node.id);
		return node;
	};

	const doc = put(folderOf(document, FolderRole.SVGS).id,
		createNode(NodeType.SVG_DOC, { name: 'a.svg' }, { newId }));
	const path = put(doc.id, createNode(NodeType.SVG_PATH, { name: 'line', closed: false }, { newId }));

	const tool = put(folderOf(document, FolderRole.JOBS).id,
		createNode(NodeType.TOOL, { name: 'Bit' }, { newId }));
	const spare = put(folderOf(document, FolderRole.JOBS).id,
		createNode(NodeType.TOOL, { name: 'Other' }, { newId }));
	const a = put(tool.id, createNode(NodeType.JOB, { name: 'A', paths: [path.id] }, { newId }));
	const b = put(tool.id, createNode(NodeType.JOB, { name: 'B', paths: [path.id] }, { newId }));

	// verify is on by default under vitest, which is the point of it
	const store = createProjectStore({ project });

	return { store, newId, n: { doc, path, tool, spare, a, b } };
}

/**
 * Counts how many times an effect re-runs, and what it last saw.
 *
 * @param {Function} read - the thing to watch
 * @returns {Object} `{ runs, last }`, both live
 */
function watcher(read) {
	const seen = { runs: 0, last: undefined };
	effect(() => { seen.runs += 1; seen.last = read(); });
	return seen;
}


describe('the factory', () => {

	it('is keyed by the project, not shared', () => {
		const one = fixture('one').store;
		const two = fixture('two').store;

		expect(one.id).not.toBe(two.id);
		one.dispatch(setField(one.document, one.id, 'safeZ', 9));
		expect(two.document.nodes[two.id].safeZ).toBe(5);
	});

	it('refuses anything that is not a project', () => {
		expect(() => createProjectStore({ project: { nodes: {} } })).toThrow(/needs a project/);
	});

	it('leaves the document a plain object, with no proxy anywhere', () => {
		const { store, n } = fixture();

		// the whole convention: core must be able to clone and diff this at speed,
		// and structuredClone throws DataCloneError on a proxy
		expect(() => structuredClone(store.document)).not.toThrow();
		expect(store.document.nodes[n.a.id]).toBe(store.project.document.nodes[n.a.id]);
	});
});


describe('per-node reactivity', () => {

	it('hands out the same ref for the same node', () => {
		const { store, n } = fixture();

		expect(store.nodeRef(n.a.id)).toBe(store.nodeRef(n.a.id));
	});

	it('updates the node that changed', () => {
		const { store, n } = fixture();
		const seen = watcher(() => store.nodeRef(n.a.id).value?.cutDepth);

		store.dispatch(setField(store.document, n.a.id, 'cutDepth', 7));

		expect(seen.last).toBe(7);
		expect(seen.runs).toBe(2);
	});

	it('does NOT update a node that did not', () => {
		// the reason this is per-node rather than one big ref: a view watching one
		// job must not re-run because a different job moved
		const { store, n } = fixture();
		const other = watcher(() => store.nodeRef(n.b.id).value?.cutDepth);

		store.dispatch(setField(store.document, n.a.id, 'cutDepth', 7));

		expect(other.runs).toBe(1);
	});

	it('republishes a DESCENDANT of a touched subtree, whose object undo replaced', () => {
		// The one that matters, and the one the first version of this file did not
		// have. Undo restores CLONES, so every node inside a restored subtree is a
		// new object even when its values are identical. Publishing only the ids
		// named in `touches` leaves a view holding the detached original forever,
		// with nothing to show that anything went wrong.
		//
		// Mutating the store to republish every ref instead broke no test at all,
		// because shallowRef compares with Object.is and an untouched node is
		// still the same object. Identity is what makes this fine-grained; the
		// touched set is what makes it correct.
		const { store, n } = fixture();

		store.dispatch(removeNode(store.document, n.b.id));
		const seen = watcher(() => store.nodeRef(n.a.id).value);
		const detached = store.document.nodes[n.a.id];

		store.undo();

		expect(store.document.nodes[n.a.id]).not.toBe(detached);
		expect(seen.last).toBe(store.document.nodes[n.a.id]);
		expect(seen.runs).toBe(2);
	});

	it('leaves an untouched node’s ref alone even across an undo', () => {
		const { store, n } = fixture();

		store.dispatch(setField(store.document, n.a.id, 'cutDepth', 7));
		const other = watcher(() => store.nodeRef(n.b.id).value);
		store.undo();

		expect(other.runs).toBe(1);
	});

	it('updates a whole subtree when a structural command touches its parent', () => {
		const { store, n } = fixture();
		const job = watcher(() => store.nodeRef(n.a.id).value?.name);

		store.dispatch(moveNode(store.document, n.a.id, n.spare.id));

		// the job's own data did not change, but it was inside a touched subtree,
		// so its ref is republished rather than left holding a detached object
		expect(job.runs).toBe(2);
		expect(store.nodeRef(n.a.id).value).toBe(store.document.nodes[n.a.id]);
	});

	it('goes to null for a deleted node, and comes back on undo', () => {
		const { store, n } = fixture();
		const seen = watcher(() => store.nodeRef(n.a.id).value);

		store.dispatch(removeNode(store.document, n.a.id));
		expect(seen.last).toBeNull();

		store.undo();
		expect(seen.last.name).toBe('A');
	});

	it('gives a ref for a node that does not exist yet, and fills it in', () => {
		const { store, n, newId } = fixture();
		const job = createNode(NodeType.JOB, { name: 'Later' }, { newId });
		const seen = watcher(() => store.nodeRef(job.id).value?.name);

		expect(seen.last).toBeUndefined();

		store.dispatch(addNode(store.document, n.tool.id, job));
		expect(seen.last).toBe('Later');
	});
});


describe('selection', () => {

	it('changes without going on the undo stack', () => {
		const { store, n } = fixture();

		store.select([n.a.id, n.b.id]);

		expect(store.selection.value).toEqual({ active: n.b.id, ids: [n.a.id, n.b.id] });
		expect(store.canUndo.value).toBe(false);
	});

	it('is still restored by undoing a command made while it was set', () => {
		// "undo restores selection" without "clicking around fills the stack"
		const { store, n } = fixture();

		store.select([n.a.id]);
		store.dispatch(setField(store.document, n.a.id, 'cutDepth', 4));
		store.select([n.b.id]);

		store.undo();
		expect(store.selection.value.active).toBe(n.a.id);
	});

	it('ignores ids that are not in the document', () => {
		const { store, n } = fixture();

		store.select(['ghost', n.a.id]);
		expect(store.selection.value.ids).toEqual([n.a.id]);
	});

	it('takes an explicit active node for a multi-select', () => {
		const { store, n } = fixture();

		store.select([n.a.id, n.b.id], { active: n.a.id });
		expect(store.selection.value.active).toBe(n.a.id);
	});
});


describe('undo, redo and what the menu says', () => {

	it('tracks what there is to undo', () => {
		const { store, n } = fixture();
		const seen = watcher(() => store.undoLabel.value);

		expect(store.canUndo.value).toBe(false);

		store.dispatch(setField(store.document, n.a.id, 'cutDepth', 4));
		expect(seen.last).toBe('Set cut depth');
		expect(store.canRedo.value).toBe(false);

		store.undo();
		expect(store.canUndo.value).toBe(false);
		expect(store.redoLabel.value).toBe('Set cut depth');
	});

	it('seals, so the next edit to the same field is its own entry', () => {
		const { store, n } = fixture();

		store.dispatch(setField(store.document, n.a.id, 'cutDepth', 4));
		store.seal();
		store.dispatch(setField(store.document, n.a.id, 'cutDepth', 5));

		store.undo();
		expect(store.document.nodes[n.a.id].cutDepth).toBe(4);
	});
});


describe('what the views read', () => {

	it('recomputes diagnostics once per commit', () => {
		const { store, n } = fixture();
		const seen = watcher(() => store.diagnostics.value.map((d) => d.code));

		expect(seen.last).toContain('depth-groove');

		store.dispatch(setField(store.document, n.a.id, 'cutDepth', 5));
		expect(seen.last).toContain('depth-through');

		store.dispatch(setField(store.document, store.id, 'materialThickness', 18));
		expect(seen.last).toContain('depth-groove');
		expect(seen.runs).toBe(3);
	});

	it('reports a project with an error as blocking, through the same channel', () => {
		const { store, n } = fixture();

		store.dispatch(setField(store.document, n.a.id, 'operation', 'pocket'));

		expect(store.diagnostics.value.some((d) => d.level === Level.ERROR)).toBe(true);
	});

	it('keeps saying the shape is sound', () => {
		const { store, n } = fixture();
		const seen = watcher(() => store.problems.value);

		store.dispatch(removeNode(store.document, n.path.id));
		expect(seen.last).toEqual([]);
	});

	it('resolves a node with provenance, for the Inspector', () => {
		const { store, n } = fixture();

		expect(store.resolved(n.a.id).cutFeed).toMatchObject({ source: Source.INHERITED, from: n.tool.id });

		store.dispatch(setField(store.document, n.a.id, 'cutFeed', 400));
		expect(store.resolved(n.a.id).cutFeed).toMatchObject({ value: 400, source: Source.OWN });

		store.dispatch(clearOverride(store.document, n.a.id, 'cutFeed'));
		store.dispatch(setField(store.document, n.tool.id, 'cutFeed', 900));
		expect(store.values(n.a.id).cutFeed).toBe(900);
	});

	it('lists children in order', () => {
		const { store, n } = fixture();

		expect(store.children(n.tool.id).map((x) => x.name)).toEqual(['A', 'B']);
	});
});


describe('commits, saving and loading', () => {

	it('announces every commit once, for codegen', () => {
		const { store, n } = fixture();
		const onCommit = vi.fn();
		const watched = createProjectStore({ project: store.project, onCommit });

		for (const depth of [2, 3, 4])
			watched.dispatch(setField(watched.document, n.a.id, 'cutDepth', depth));

		watched.undo();

		expect(onCommit.mock.calls.map(([e]) => e.kind)).toEqual(['do', 'coalesce', 'coalesce', 'undo']);
		expect(onCommit.mock.calls.at(-1)[0].touches).toEqual([n.a.id]);
	});

	it('goes dirty on a change and clean on a save', () => {
		const { store, n } = fixture();

		expect(store.dirty.value).toBe(false);
		store.dispatch(setField(store.document, n.a.id, 'cutDepth', 4));
		expect(store.dirty.value).toBe(true);

		store.markSaved();
		expect(store.dirty.value).toBe(false);

		store.undo();
		expect(store.dirty.value).toBe(true);
	});

	it('loads another project, and forgets the history that described this one', () => {
		// one undo after a load would otherwise splice the previous project's
		// nodes into this one
		const { store, n } = fixture();
		const seen = watcher(() => store.nodeRef(n.a.id).value?.name);

		store.dispatch(setField(store.document, n.a.id, 'cutDepth', 4));
		store.load(createProject({ name: 'Fresh', newId: counter() }));

		expect(store.canUndo.value).toBe(false);
		expect(store.dirty.value).toBe(false);
		expect(seen.last).toBeUndefined();
		expect(store.document.nodes[store.document.root].name).toBe('Fresh');
		expect(store.problems.value).toEqual([]);
	});

	it('keeps the document object’s identity across a load', () => {
		// callers hold store.document; swapping the object would strand them
		const { store } = fixture();
		const before = store.document;

		store.load(createProject({ name: 'Fresh', newId: counter() }));

		expect(store.document).toBe(before);
		expect(store.project.document).toBe(before);
	});

	it('refuses to load something that is not a project', () => {
		const { store } = fixture();

		expect(() => store.load({ nodes: {} })).toThrow(/needs a project/);
	});
});
