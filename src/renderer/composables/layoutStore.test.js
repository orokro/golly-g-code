import { describe, it, expect } from 'vitest';
import { createLayoutStore, LAYOUT_KEY, LAYOUT_VERSION } from './layoutStore.js';

/** The smallest thing that behaves like localStorage, including breaking. */
const fakeStorage = (initial = {}) => {
	const values = { ...initial };
	return {
		values,
		getItem: (k) => (k in values ? values[k] : null),
		setItem: (k, v) => { values[k] = v; },
		removeItem: (k) => { delete values[k]; },
	};
};

/** A controllable timer, so the debounce can be tested without waiting. */
const fakeTimers = () => {
	let next = 1;
	const due = new Map();
	return {
		setTimer: (fn) => { due.set(next, fn); return next++; },
		clearTimer: (id) => { due.delete(id); },
		run() { const all = [...due.values()]; due.clear(); all.forEach((fn) => fn()); },
		get pending() { return due.size; },
	};
};

const layout = [{ name: 'window', top: 0, left: 0, right: 1920, bottom: 1080 }];


describe('saving', () => {

	it('waits for changes to stop before writing', () => {
		// dragging a splitter emits a change per mouse move; writing on each one
		// serialises the whole tree hundreds of times a second during the one
		// interaction where a dropped frame is most visible
		const storage = fakeStorage();
		const timers = fakeTimers();
		const store = createLayoutStore({ storage, ...timers });

		store.save(layout);
		store.save(layout);
		store.save(layout);

		expect(storage.values[LAYOUT_KEY]).toBeUndefined();
		expect(timers.pending).toBe(1);

		timers.run();
		expect(storage.values[LAYOUT_KEY]).toBeDefined();
	});

	it('writes the last layout, not the first', () => {
		const storage = fakeStorage();
		const timers = fakeTimers();
		const store = createLayoutStore({ storage, ...timers });

		store.save([{ name: 'old' }]);
		store.save([{ name: 'new' }]);
		timers.run();

		expect(JSON.parse(storage.values[LAYOUT_KEY]).layout).toEqual([{ name: 'new' }]);
	});

	it('flushes on demand, for a window about to close', () => {
		const storage = fakeStorage();
		const timers = fakeTimers();
		const store = createLayoutStore({ storage, ...timers });

		store.save(layout);
		expect(store.flush()).toBe(true);
		expect(storage.values[LAYOUT_KEY]).toBeDefined();
		expect(timers.pending).toBe(0);
	});

	it('survives a storage that refuses to write', () => {
		// full, or disabled by policy. Losing a remembered layout is survivable;
		// taking the app down over it is not
		const storage = fakeStorage();
		storage.setItem = () => { throw new Error('QuotaExceededError'); };
		const timers = fakeTimers();
		const store = createLayoutStore({ storage, ...timers });

		store.save(layout);
		expect(() => timers.run()).not.toThrow();
	});
});


describe('loading', () => {

	const stored = (value) => fakeStorage({ [LAYOUT_KEY]: JSON.stringify(value) });

	it('returns a layout it wrote itself', () => {
		const storage = fakeStorage();
		const timers = fakeTimers();
		const store = createLayoutStore({ storage, ...timers });

		store.save(layout);
		timers.run();

		expect(createLayoutStore({ storage, ...timers }).load()).toEqual(layout);
	});

	it('returns null when nothing is stored', () => {
		expect(createLayoutStore({ storage: fakeStorage() }).load()).toBeNull();
	});

	it('discards a layout from a different version', () => {
		// a layout saved by an older build can restore an app the user cannot
		// fix from inside the app; a fresh default is the milder failure
		const storage = stored({ version: LAYOUT_VERSION + 1, layout });
		expect(createLayoutStore({ storage }).load()).toBeNull();
	});

	it('discards anything that is not JSON', () => {
		const storage = fakeStorage({ [LAYOUT_KEY]: '{ this is not json' });
		expect(createLayoutStore({ storage }).load()).toBeNull();
	});

	it('discards JSON that is the wrong shape', () => {
		for (const value of [{ version: LAYOUT_VERSION }, { version: LAYOUT_VERSION, layout: 'no' }, null, 42])
			expect(createLayoutStore({ storage: stored(value) }).load()).toBeNull();
	});

	it('discards a layout naming a window this build does not have', () => {
		const storage = stored({
			version: LAYOUT_VERSION,
			layout: [{ name: 'main', windows: ['workspace', 'somethingRemoved'] }],
		});
		expect(createLayoutStore({ storage, knownSlugs: ['workspace'] }).load()).toBeNull();
	});

	it('accepts a layout whose windows all exist, in either notation', () => {
		const storage = stored({
			version: LAYOUT_VERSION,
			layout: [{ name: 'main', windows: ['workspace', { kind: 'inspector', props: {} }] }],
		});
		expect(createLayoutStore({ storage, knownSlugs: ['workspace', 'inspector'] }).load())
			.not.toBeNull();
	});

	it('survives a storage that refuses to read', () => {
		const storage = fakeStorage();
		storage.getItem = () => { throw new Error('SecurityError'); };
		expect(createLayoutStore({ storage }).load()).toBeNull();
	});
});


describe('clearing', () => {

	it('removes the layout and cancels any pending write', () => {
		const storage = fakeStorage();
		const timers = fakeTimers();
		const store = createLayoutStore({ storage, ...timers });

		store.save(layout);
		store.clear();
		timers.run();

		expect(storage.values[LAYOUT_KEY]).toBeUndefined();
	});

	it('does not resurrect the layout on a later flush', () => {
		const storage = fakeStorage();
		const timers = fakeTimers();
		const store = createLayoutStore({ storage, ...timers });

		store.save(layout);
		store.clear();

		expect(store.flush()).toBe(false);
		expect(storage.values[LAYOUT_KEY]).toBeUndefined();
	});
});
