import { describe, it, expect, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';

import { NodeType, FolderRole, createNode } from '@core/project/nodes.js';
import { createProject } from '@core/project/document.js';
import { folderOf } from '@core/project/tree.js';
import { setField } from '@core/project/commands.js';

import { createProjectStore } from './projectStore.js';
import { useToolpaths, State } from './useToolpaths.js';

/** Deterministic ids. */
const counter = () => { let k = 0; return () => `n${(k += 1)}`; };

/**
 * A store with one job, and a fake clock for the debounce.
 *
 * @param {Function} [generate] - the generator to use
 * @returns {Object} everything the tests need
 */
function fixture(generate = vi.fn(async () => [])) {

	const newId = counter();
	const project = createProject({ newId });
	const document = project.document;

	const tool = createNode(NodeType.TOOL, { name: 'Bit' }, { newId });
	const job = createNode(NodeType.JOB, { name: 'Cut' }, { newId });
	tool.children = [job.id];
	document.nodes[tool.id] = tool;
	document.nodes[job.id] = job;
	folderOf(document, FolderRole.JOBS).children.push(tool.id);

	const store = createProjectStore({ project });

	/** @type {Function[]} pending timers, fired by hand */
	const timers = [];
	const scope = effectScope();

	let api;
	scope.run(() => {
		api = useToolpaths({
			store,
			generate,
			schedule: (fn) => { timers.push(fn); return timers.length; },
			cancel: (handle) => { timers[handle - 1] = null; },
		});
	});

	/**
	 * Fires every pending timer and lets the generation finish.
	 *
	 * A real macrotask at the end, not just `nextTick`: the generator is async,
	 * so its resolution and its rejection both land a turn later than the timer
	 * that started it, and two microtask flushes were not reliably enough.
	 *
	 * @returns {Promise<void>} once everything has settled
	 */
	const settle = async () => {

		// the watcher is async, so a dispatch has not queued anything yet when
		// this is called -- draining the timers first drains an empty list and
		// leaves the real one pending forever
		await nextTick();

		const due = timers.splice(0).filter(Boolean);

		for (const fn of due)
			fn();

		await nextTick();
		await new Promise((resolve) => { setTimeout(resolve, 0); });
	};

	return { store, job, generate, timers, settle, scope, ...api };
}


describe('keeping up with the document', () => {

	it('generates once at the start', async () => {
		const f = fixture();
		await f.settle();

		expect(f.generate).toHaveBeenCalledOnce();
		expect(f.state.value).toBe(State.IDLE);
	});

	it('queues rather than generating on every commit', async () => {
		// a slider drag coalesces into one undo entry but still publishes on
		// every step; regenerating forty times to show the fortieth is work
		// nobody sees
		const f = fixture();
		await f.settle();
		f.generate.mockClear();

		for (const depth of [2, 3, 4, 5])
			f.store.dispatch(setField(f.store.document, f.job.id, 'cutDepth', depth));

		await nextTick();
		expect(f.generate).not.toHaveBeenCalled();
		expect(f.state.value).toBe(State.QUEUED);

		await f.settle();
		expect(f.generate).toHaveBeenCalledOnce();
	});

	it('regenerates immediately when asked outright', async () => {
		const f = fixture();
		await f.settle();
		f.generate.mockClear();

		await f.regenerate();

		expect(f.generate).toHaveBeenCalledOnce();
		expect(f.state.value).toBe(State.IDLE);
	});

	it('publishes what came back, and what the jobs had to say', async () => {
		const generate = vi.fn(async () => [
			{ jobId: 'a', paths: [{ points: [[0, 0]], closed: false }], warnings: ['careful'] },
		]);
		const f = fixture(generate);
		await f.settle();

		expect(f.toolpaths.value).toHaveLength(1);
		expect(f.warnings.value).toEqual(['careful']);
	});

	it('drops the old result when the generator throws', async () => {
		// leaving the last good toolpath on screen would show a cut for a
		// document that no longer exists
		const generate = vi.fn()
			.mockResolvedValueOnce([{ jobId: 'a', paths: [], warnings: [] }])
			.mockRejectedValueOnce(new Error('clipper said no'));
		const f = fixture(generate);
		await f.settle();

		expect(f.toolpaths.value).toHaveLength(1);

		f.store.dispatch(setField(f.store.document, f.job.id, 'cutDepth', 3));
		await f.settle();

		expect(f.state.value).toBe(State.FAILED);
		expect(f.toolpaths.value).toEqual([]);
		expect(f.warnings.value).toEqual(['clipper said no']);
	});

	it('stops when its scope goes away', async () => {
		const f = fixture();
		await f.settle();
		f.generate.mockClear();

		f.store.dispatch(setField(f.store.document, f.job.id, 'cutDepth', 3));
		f.scope.stop();
		await f.settle();

		expect(f.generate).not.toHaveBeenCalled();
	});

	it('refuses to be built without a store', () => {
		expect(() => useToolpaths({})).toThrow(/needs a store/);
	});
});
