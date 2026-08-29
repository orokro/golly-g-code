import { describe, it, expect, vi } from 'vitest';
import { createHistory, DEFAULT_COALESCE_WINDOW_MS } from './history.js';
import { nodeDriver, cloneState, diffStates } from './snapshot.js';

/**
 * A fresh project: root -> Jobs (A, B) and SVGs (C).
 *
 * @returns {Object} the state
 */
const fixture = () => ({
	root: 'root',
	nodes: {
		root: { id: 'root', type: 'Project', name: 'Project', children: ['jobs', 'svgs'] },
		jobs: { id: 'jobs', type: 'Folder', name: 'Jobs', children: ['a', 'b'] },
		svgs: { id: 'svgs', type: 'Folder', name: 'SVGs', children: ['c'] },
		a: { id: 'a', type: 'Job', name: 'A', depth: 3, children: [] },
		b: { id: 'b', type: 'Job', name: 'B', depth: 5, children: [] },
		c: { id: 'c', type: 'SvgDoc', name: 'skyline.svg', children: [] },
	},
	selection: { active: 'a', ids: ['a'] },
});

/** A history with the correctness check on, which is how tests should run it. */
const history = (options = {}) => createHistory({ driver: nodeDriver, verify: true, ...options });

/**
 * A correctly-declared field edit.
 *
 * @param {String} id - the node
 * @param {String} field - the field
 * @param {*} value - the new value
 * @param {String} [coalesceKey] - when the edit should merge with its neighbours
 * @returns {Object} the command
 */
const setField = (id, field, value, coalesceKey) => ({
	label: `Set ${field}`,
	touches: [id],
	coalesceKey,
	apply: (state) => { state.nodes[id][field] = value; },
});


describe('dispatching', () => {

	it('is the thing that changes the document', () => {
		const state = fixture();
		history().dispatch(state, setField('a', 'depth', 12));

		expect(state.nodes.a.depth).toBe(12);
	});

	it('records what it did, for the menu', () => {
		const state = fixture();
		const h = history();

		expect(h.canUndo()).toBe(false);
		expect(h.undoLabel()).toBeNull();

		h.dispatch(state, setField('a', 'depth', 12));

		expect(h.canUndo()).toBe(true);
		expect(h.undoLabel()).toBe('Set depth');
		expect(h.depth()).toEqual({ past: 1, future: 0 });
	});

	it('refuses a malformed command instead of half-running it', () => {
		const state = fixture();
		const h = history();

		expect(() => h.dispatch(state, null)).toThrow(/must be an object/);
		expect(() => h.dispatch(state, { touches: ['a'], apply: () => {} })).toThrow(/needs a label/);
		expect(() => h.dispatch(state, { label: 'X', touches: ['a'] })).toThrow(/no apply/);
		expect(() => h.dispatch(state, { label: 'X', apply: () => {} })).toThrow(/declares no touches/);
		expect(() => h.dispatch(state, { label: 'X', touches: [], apply: () => {} })).toThrow(/declares no touches/);
		expect(() => h.dispatch(state, { label: 'X', touches: [7], apply: () => {} })).toThrow(/not an id/);
		expect(() => h.dispatch(state, { label: 'X', touches: ['a', 'a'], apply: () => {} })).toThrow(/twice/);

		expect(h.canUndo()).toBe(false);
	});
});


describe('undo and redo', () => {

	it('goes back and forward again', () => {
		const state = fixture();
		const h = history();

		h.dispatch(state, setField('a', 'depth', 12));
		h.undo(state);
		expect(state.nodes.a.depth).toBe(3);

		h.redo(state);
		expect(state.nodes.a.depth).toBe(12);
	});

	it('returns null rather than throwing at either end', () => {
		const state = fixture();
		const h = history();

		expect(h.undo(state)).toBeNull();
		expect(h.redo(state)).toBeNull();
	});

	it('restores the selection the command was made with', () => {
		const state = fixture();
		const h = history();

		h.dispatch(state, {
			label: 'Delete job',
			touches: ['jobs'],
			apply: (s) => {
				s.nodes.jobs.children = ['a'];
				delete s.nodes.b;
				s.selection = { active: null, ids: [] };
			},
		});

		expect(state.selection).toEqual({ active: null, ids: [] });

		h.undo(state);
		expect(state.nodes.b).toBeDefined();
		expect(state.selection).toEqual({ active: 'a', ids: ['a'] });

		h.redo(state);
		expect(state.selection).toEqual({ active: null, ids: [] });
	});

	it('restores rather than re-running apply', () => {
		// the reason this matters: an apply that mints an id would mint a DIFFERENT
		// one on redo, and every reference to the first would point at nothing
		const state = fixture();
		const h = history();
		let minted = 0;

		h.dispatch(state, {
			label: 'Add job',
			touches: ['jobs'],
			apply: (s) => {
				minted += 1;
				const id = `job-${minted}`;
				s.nodes[id] = { id, type: 'Job', name: 'New', children: [] };
				s.nodes.jobs.children.push(id);
			},
		});

		expect(state.nodes.jobs.children).toEqual(['a', 'b', 'job-1']);

		h.undo(state);
		h.redo(state);

		expect(minted).toBe(1);
		expect(state.nodes.jobs.children).toEqual(['a', 'b', 'job-1']);
		expect(state.nodes['job-1']).toBeDefined();
	});

	it('drops the redo stack when a new command arrives', () => {
		const state = fixture();
		const h = history();

		h.dispatch(state, setField('a', 'depth', 12));
		h.undo(state);
		expect(h.canRedo()).toBe(true);

		h.dispatch(state, setField('a', 'depth', 20));

		expect(h.canRedo()).toBe(false);
		expect(h.redo(state)).toBeNull();
		expect(state.nodes.a.depth).toBe(20);
	});

	it('forgets everything on clear, because the snapshots describe another document', () => {
		const state = fixture();
		const h = history();

		h.dispatch(state, setField('a', 'depth', 12));
		h.undo(state);
		h.clear();

		expect(h.depth()).toEqual({ past: 0, future: 0 });
		expect(h.canUndo()).toBe(false);
		expect(h.canRedo()).toBe(false);
	});
});


describe('coalescing', () => {

	/** A clock the test drives by hand. */
	const clock = () => {
		let t = 1000;
		return { now: () => t, advance: (ms) => { t += ms; } };
	};

	it('collapses a drag into one entry, reaching back to where it started', () => {
		const state = fixture();
		const h = history();

		for (const depth of [4, 5, 6, 7])
			h.dispatch(state, setField('a', 'depth', depth, 'field:a:depth'));

		expect(state.nodes.a.depth).toBe(7);
		expect(h.depth()).toEqual({ past: 1, future: 0 });

		h.undo(state);
		expect(state.nodes.a.depth).toBe(3);
	});

	it('does not merge two different fields', () => {
		const state = fixture();
		const h = history();

		h.dispatch(state, setField('a', 'depth', 4, 'field:a:depth'));
		h.dispatch(state, setField('a', 'name', 'Renamed', 'field:a:name'));

		expect(h.depth().past).toBe(2);
	});

	it('does not merge commands that touch different nodes', () => {
		// same key, different touches: merging would leave the entry's before
		// snapshot with no record of the second node's earlier value
		const state = fixture();
		const h = history();

		h.dispatch(state, { ...setField('a', 'depth', 4, 'drag'), touches: ['a'] });
		h.dispatch(state, { ...setField('b', 'depth', 9, 'drag'), touches: ['b'] });

		expect(h.depth().past).toBe(2);

		h.undo(state);
		h.undo(state);
		expect(state.nodes.a.depth).toBe(3);
		expect(state.nodes.b.depth).toBe(5);
	});

	it('does not merge an uncoalescable command into anything', () => {
		const state = fixture();
		const h = history();

		h.dispatch(state, setField('a', 'depth', 4));
		h.dispatch(state, setField('a', 'depth', 5));

		expect(h.depth().past).toBe(2);
	});

	it('stops at seal, which is the mechanism', () => {
		const state = fixture();
		const h = history();

		h.dispatch(state, setField('a', 'depth', 4, 'field:a:depth'));
		h.seal();
		h.dispatch(state, setField('a', 'depth', 5, 'field:a:depth'));

		expect(h.depth().past).toBe(2);
	});

	it('stops after the window, which is only the safety net', () => {
		const state = fixture();
		const c = clock();
		const h = history({ now: c.now });

		h.dispatch(state, setField('a', 'depth', 4, 'field:a:depth'));
		c.advance(DEFAULT_COALESCE_WINDOW_MS + 1);
		h.dispatch(state, setField('a', 'depth', 5, 'field:a:depth'));

		expect(h.depth().past).toBe(2);
	});

	it('keeps the window open while the drag is still moving', () => {
		const state = fixture();
		const c = clock();
		const h = history({ now: c.now });

		// each step is well inside the window, but the whole drag is not -- the
		// window is measured from the last write, not from the first
		for (let i = 0; i < 10; i += 1) {
			c.advance(DEFAULT_COALESCE_WINDOW_MS - 1);
			h.dispatch(state, setField('a', 'depth', i, 'field:a:depth'));
		}

		expect(h.depth().past).toBe(1);
	});

	it('does not merge into an entry that has been undone and redone', () => {
		const state = fixture();
		const h = history();

		h.dispatch(state, setField('a', 'depth', 4, 'field:a:depth'));
		h.undo(state);
		h.redo(state);
		h.dispatch(state, setField('a', 'depth', 5, 'field:a:depth'));

		expect(h.depth().past).toBe(2);
	});
});


describe('the depth limit', () => {

	it('drops the oldest entry rather than growing forever', () => {
		const state = fixture();
		const h = history({ limit: 3 });

		for (const depth of [1, 2, 3, 4, 5])
			h.dispatch(state, setField('a', 'depth', depth));

		expect(h.depth()).toEqual({ past: 3, future: 0 });

		for (let i = 0; i < 3; i += 1)
			h.undo(state);

		// undo reaches back as far as the oldest entry kept, and no further
		expect(state.nodes.a.depth).toBe(2);
		expect(h.canUndo()).toBe(false);
	});

	it('refuses a limit that would keep nothing', () => {
		expect(() => history({ limit: 0 })).toThrow(/at least 1/);
	});
});


describe('the correctness check', () => {

	it('catches a command that changes more than it declared', () => {
		// this is the one way the snapshot design can be wrong, so the check for it
		// is tested by making the mistake on purpose rather than by trusting it
		const state = fixture();
		const h = history();

		expect(() => h.dispatch(state, {
			label: 'Sloppy rename',
			touches: ['a'],
			apply: (s) => {
				s.nodes.a.name = 'Renamed';
				s.nodes.b.name = 'also this one, undeclared';
			},
		})).toThrow(/outside its touches \[a\][\s\S]*nodes\.b\.name/);
	});

	it('catches a structural change that touches the child instead of the parent', () => {
		// the mistake the rule in snapshot.js exists to prevent
		const state = fixture();
		const h = history();

		expect(() => h.dispatch(state, {
			label: 'Delete job',
			touches: ['b'],
			apply: (s) => {
				s.nodes.jobs.children = ['a'];
				delete s.nodes.b;
			},
		})).toThrow(/nodes\.jobs\.children/);
	});

	it('leaves the document correct after it fires, not half-applied', () => {
		const state = fixture();
		const h = history();

		expect(() => h.dispatch(state, {
			label: 'Sloppy',
			touches: ['a'],
			apply: (s) => { s.nodes.a.name = 'X'; s.nodes.b.name = 'Y'; },
		})).toThrow();

		// the command DID run -- verify reports the mistake, it does not prevent it.
		// What it must not do is leave the tree spliced apart by its own round trip
		expect(state.nodes.a.name).toBe('X');
		expect(state.nodes.b.name).toBe('Y');
	});

	it('passes a correctly declared command', () => {
		const state = fixture();
		const h = history();

		expect(() => h.dispatch(state, {
			label: 'Move job',
			touches: ['jobs', 'svgs'],
			apply: (s) => {
				s.nodes.jobs.children = ['a'];
				s.nodes.svgs.children = ['c', 'b'];
			},
		})).not.toThrow();
	});

	it('is off by default, because it copies the whole document twice', () => {
		const state = fixture();
		const h = createHistory({ driver: nodeDriver });

		expect(() => h.dispatch(state, {
			label: 'Sloppy',
			touches: ['a'],
			apply: (s) => { s.nodes.b.name = 'undeclared'; },
		})).not.toThrow();
	});

	it('refuses to be switched on without the driver it needs', () => {
		expect(() => createHistory({ driver: { capture: () => {}, restore: () => {} }, verify: true }))
			.toThrow(/verify needs/);
	});
});


describe('announcing commits', () => {

	it('fires once per committed command, not once per mouse move', () => {
		// this is the G-code regeneration trigger: a drag that emits forty
		// commands is one entry and therefore one regeneration
		const state = fixture();
		const onCommit = vi.fn();
		const h = history({ onCommit });

		for (const depth of [4, 5, 6])
			h.dispatch(state, setField('a', 'depth', depth, 'field:a:depth'));

		expect(onCommit.mock.calls.map(([e]) => e.kind)).toEqual(['do', 'coalesce', 'coalesce']);
		expect(onCommit.mock.calls.at(-1)[0]).toMatchObject({ label: 'Set depth', touches: ['a'] });
	});

	it('names what went stale, so codegen can regenerate only that', () => {
		const state = fixture();
		const onCommit = vi.fn();
		const h = history({ onCommit });

		h.dispatch(state, {
			label: 'Move job', touches: ['jobs', 'svgs'],
			apply: (s) => { s.nodes.jobs.children = ['a']; s.nodes.svgs.children = ['c', 'b']; },
		});
		h.undo(state);
		h.redo(state);

		expect(onCommit.mock.calls.map(([e]) => e.kind)).toEqual(['do', 'undo', 'redo']);
		for (const [event] of onCommit.mock.calls)
			expect(event.touches).toEqual(['jobs', 'svgs']);
	});
});


describe('a session of random edits', () => {

	/**
	 * A small deterministic PRNG, so a failure can be reproduced from its seed.
	 *
	 * @param {Number} seed - the seed
	 * @returns {Function} returns a float in [0, 1)
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
	 * Invents a plausible edit against whatever the tree currently looks like.
	 *
	 * Structural as well as scalar, because the interesting bugs in a snapshot
	 * scheme are all structural: deleting, adding and moving between parents.
	 *
	 * @param {Object} state - the state
	 * @param {Function} rand - the PRNG
	 * @param {Object} counter - a mutable id counter
	 * @returns {Object|null} a command, or null when nothing applies
	 */
	function invent(state, rand, counter) {

		const folders = ['jobs', 'svgs'];
		const from = folders[Math.floor(rand() * folders.length)];
		const to = folders.find((f) => f !== from);
		const kids = state.nodes[from].children;
		const pick = (list) => list[Math.floor(rand() * list.length)];
		const roll = rand();

		if (roll < 0.3) {
			counter.n += 1;
			const id = `n${counter.n}`;
			return {
				label: 'Add', touches: [from],
				apply: (s) => {
					s.nodes[id] = { id, type: 'Job', name: id, depth: 1, children: [] };
					s.nodes[from].children.push(id);
					s.selection = { active: id, ids: [id] };
				},
			};
		}

		if (kids.length === 0)
			return null;

		const child = pick(kids);

		if (roll < 0.5)
			return {
				label: 'Delete', touches: [from],
				apply: (s) => {
					for (const gone of [...(s.nodes[child].children ?? []), child])
						delete s.nodes[gone];
					s.nodes[from].children = s.nodes[from].children.filter((k) => k !== child);
					s.selection = { active: null, ids: [] };
				},
			};

		if (roll < 0.7)
			return {
				label: 'Move', touches: [from, to],
				apply: (s) => {
					s.nodes[from].children = s.nodes[from].children.filter((k) => k !== child);
					s.nodes[to].children.push(child);
				},
			};

		if (roll < 0.85)
			return {
				label: 'Reorder', touches: [from],
				apply: (s) => { s.nodes[from].children = [...s.nodes[from].children].reverse(); },
			};

		return {
			label: 'Set depth', touches: [child],
			coalesceKey: rand() < 0.6 ? `field:${child}:depth` : undefined,
			apply: (s) => { s.nodes[child].depth = Math.round(rand() * 20); },
		};
	}

	/**
	 * Runs a random session.
	 *
	 * @param {Number} seed - the seed
	 * @param {Number} steps - how many commands to attempt
	 * @returns {Object} the state, the history and the states along the way
	 */
	function session(seed, steps) {
		const rand = random(seed);
		const state = fixture();
		const h = history();
		const counter = { n: 0 };
		const marks = [cloneState(state)];

		for (let i = 0; i < steps; i += 1) {

			const command = invent(state, rand, counter);

			if (command === null)
				continue;

			// A coalescing command stands for a drag, so it is dispatched as one:
			// a run of edits under the same key. Emitted singly, coalescing
			// happened once in two thousand commands and the round-trip claims
			// below barely covered it.
			const run = command.coalesceKey === undefined ? 1 : 2 + Math.floor(rand() * 5);

			for (let step = 0; step < run; step += 1)
				h.dispatch(state, command);

			if (rand() < 0.3)
				h.seal();

			marks.push(cloneState(state));
		}

		return { state, h, marks };
	}

	it('comes all the way back, for every seed', () => {
		for (let seed = 1; seed <= 40; seed += 1) {
			const { state, h, marks } = session(seed, 60);

			while (h.canUndo())
				h.undo(state);

			expect(diffStates(marks[0], state), `seed ${seed}`).toEqual([]);
		}
	});

	it('goes all the way forward again, for every seed', () => {
		for (let seed = 1; seed <= 40; seed += 1) {
			const { state, h } = session(seed, 60);
			const ending = cloneState(state);

			while (h.canUndo())
				h.undo(state);

			while (h.canRedo())
				h.redo(state);

			expect(diffStates(ending, state), `seed ${seed}`).toEqual([]);
		}
	});

	it('lands in the same place however far back it goes first', () => {
		for (let seed = 1; seed <= 20; seed += 1) {
			const { state, h } = session(seed, 40);
			const ending = cloneState(state);
			const back = 1 + (seed % 7);

			for (let i = 0; i < back; i += 1)
				h.undo(state);

			for (let i = 0; i < back; i += 1)
				h.redo(state);

			expect(diffStates(ending, state), `seed ${seed}, ${back} back`).toEqual([]);
		}
	});

	it('never reports a command that changed more than it declared', () => {
		// verify is on throughout the sessions above; this states the claim
		// outright rather than leaving it implied by their passing
		expect(() => session(99, 200)).not.toThrow();
	});
});
