import { describe, it, expect } from 'vitest';
import { cloneData, reachable, capture, restore, cloneState, diffStates } from './snapshot.js';

/**
 * A small tree: root -> two folders, each with two leaves.
 *
 * @returns {Object} a fresh state every time
 */
const fixture = () => ({
	root: 'root',
	nodes: {
		root: { id: 'root', type: 'Project', name: 'Project', children: ['jobs', 'svgs'] },
		jobs: { id: 'jobs', type: 'Folder', name: 'Jobs', children: ['a', 'b'] },
		svgs: { id: 'svgs', type: 'Folder', name: 'SVGs', children: ['c'] },
		a: { id: 'a', type: 'Job', name: 'A', depth: 3, children: [] },
		b: { id: 'b', type: 'Job', name: 'B', depth: 5, children: ['t1'] },
		t1: { id: 't1', type: 'Tab', name: 'Tab 1', position: 12.5, children: [] },
		c: { id: 'c', type: 'SvgDoc', name: 'skyline.svg', children: [] },
	},
	selection: { active: 'a', ids: ['a'] },
});


describe('cloning plain data', () => {

	it('shares nothing with the original', () => {
		const original = { a: [1, { b: 'x' }], c: null };
		const copy = cloneData(original);

		expect(copy).toEqual(original);
		copy.a[1].b = 'changed';
		expect(original.a[1].b).toBe('x');
	});

	it('sees through a Proxy, which structuredClone cannot', () => {
		// this is the whole reason cloneData exists. Vue's reactive() hands back a
		// Proxy, and structuredClone throws DataCloneError on one -- so the built-in
		// would have worked in every test here and failed the moment 3.2 wired the
		// store into the renderer
		const target = { id: 'x', children: ['y'] };
		const proxied = new Proxy(target, { get: (t, k) => Reflect.get(t, k) });

		expect(() => structuredClone(proxied)).toThrow();
		expect(cloneData(proxied)).toEqual(target);
	});

	it('refuses anything that is not plain data, and says where', () => {
		// silently returning {} for a Date would be a corrupted document with no
		// error attached to it -- see rule 5 in CONVENTIONS.md
		expect(() => cloneData({ node: { made: new Date() } })).toThrow(/Date.*node\.made/s);
		expect(() => cloneData({ index: new Map() })).toThrow(/Map/);
		expect(() => cloneData({ onDone: () => {} })).toThrow(/function.*onDone/s);
		expect(() => cloneData({ p: new (class Thing {})() })).toThrow(/Thing/);
	});

	it('keeps primitives, including the awkward ones', () => {
		expect(cloneData({ a: 0, b: '', c: false, d: null, e: -0.5, f: NaN }))
			.toEqual({ a: 0, b: '', c: false, d: null, e: -0.5, f: NaN });
	});
});


describe('walking a subtree', () => {

	it('collects a node and everything under it', () => {
		expect([...reachable(fixture(), 'jobs')].sort()).toEqual(['a', 'b', 'jobs', 't1']);
	});

	it('collects nothing for an id that is not there', () => {
		// not an error: redoing a delete captures a subtree whose root is gone
		expect([...reachable(fixture(), 'ghost')]).toEqual([]);
	});

	it('does not hang on a malformed cycle', () => {
		const state = fixture();
		state.nodes.t1.children = ['b'];

		expect([...reachable(state, 'b')].sort()).toEqual(['b', 't1']);
	});
});


describe('capture and restore', () => {

	it('puts back a changed field', () => {
		const state = fixture();
		const before = capture(state, ['a']);

		state.nodes.a.depth = 99;
		restore(state, before);

		expect(state.nodes.a.depth).toBe(3);
	});

	it('puts back a deleted child, by capturing its parent', () => {
		const state = fixture();
		const before = capture(state, ['jobs']);

		// the rule: a structural change touches the PARENT
		state.nodes.jobs.children = ['a'];
		delete state.nodes.b;
		delete state.nodes.t1;

		restore(state, before);

		expect(state.nodes.jobs.children).toEqual(['a', 'b']);
		expect(state.nodes.b.name).toBe('B');
		expect(state.nodes.t1.position).toBe(12.5);
	});

	it('removes a node that was added after the capture', () => {
		const state = fixture();
		const before = capture(state, ['jobs']);

		state.nodes.jobs.children.push('new');
		state.nodes.new = { id: 'new', type: 'Job', name: 'New', children: [] };

		restore(state, before);

		expect(state.nodes.new).toBeUndefined();
		expect(state.nodes.jobs.children).toEqual(['a', 'b']);
	});

	it('puts back a move between two parents', () => {
		// the case that forces restore to delete everything before adding anything:
		// done one subtree at a time, the moved node is re-added under its old
		// parent and then deleted again while the new parent is cleared out
		const state = fixture();
		const before = capture(state, ['jobs', 'svgs']);

		state.nodes.jobs.children = ['a'];
		state.nodes.svgs.children = ['c', 'b'];

		restore(state, before);

		expect(state.nodes.jobs.children).toEqual(['a', 'b']);
		expect(state.nodes.svgs.children).toEqual(['c']);
		expect(state.nodes.b).toBeDefined();
	});

	it('puts back the selection along with the data', () => {
		const state = fixture();
		const before = capture(state, ['jobs']);

		state.nodes.jobs.children = ['a'];
		delete state.nodes.b;
		delete state.nodes.t1;
		state.selection = { active: null, ids: [] };

		restore(state, before);

		expect(state.selection).toEqual({ active: 'a', ids: ['a'] });
	});

	it('leaves untouched parts of the tree exactly alone', () => {
		const state = fixture();
		const before = capture(state, ['jobs']);

		state.nodes.c.name = 'renamed outside the capture';
		restore(state, before);

		// restore is not a whole-document rollback, and must not pretend to be
		expect(state.nodes.c.name).toBe('renamed outside the capture');
	});

	it('shares nothing with the state, in either direction', () => {
		const state = fixture();
		const before = capture(state, ['a']);

		state.nodes.a.name = 'mutated after capture';
		expect(before.subtrees[0].nodes.a.name).toBe('A');

		restore(state, before);
		state.nodes.a.name = 'mutated after restore';
		expect(before.subtrees[0].nodes.a.name).toBe('A');
	});
});


describe('comparing two states', () => {

	it('says nothing when they agree', () => {
		expect(diffStates(fixture(), fixture())).toEqual([]);
	});

	it('finds a changed value, and where', () => {
		const changed = fixture();
		changed.nodes.a.depth = 4;

		expect(diffStates(fixture(), changed)).toEqual(['nodes.a.depth: expected 3, found 4']);
	});

	it('finds an added key and a removed one', () => {
		const added = fixture();
		added.nodes.a.margin = 1;

		expect(diffStates(fixture(), added)[0]).toMatch(/nodes\.a\.margin: expected nothing, found 1/);
		expect(diffStates(added, fixture())[0]).toMatch(/nodes\.a\.margin: expected 1, found nothing/);
	});

	it('finds a reorder', () => {
		const reordered = fixture();
		reordered.nodes.jobs.children = ['b', 'a'];

		expect(diffStates(fixture(), reordered)).toEqual([
			'nodes.jobs.children[0]: expected "a", found "b"',
			'nodes.jobs.children[1]: expected "b", found "a"',
		]);
	});

	it('stops rather than reporting a thousand differences', () => {
		const empty = { root: 'root', nodes: {}, selection: null };

		expect(diffStates(fixture(), empty, { limit: 3 })).toHaveLength(3);
	});

	it('agrees with cloneState about what a copy is', () => {
		const state = fixture();

		expect(diffStates(state, cloneState(state))).toEqual([]);
	});
});
