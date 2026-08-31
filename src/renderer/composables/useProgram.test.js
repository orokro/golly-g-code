import { describe, it, expect, vi } from 'vitest';
import { effectScope, shallowRef, nextTick } from 'vue';

import { NodeType, FolderRole, createNode } from '@core/project/nodes.js';
import { createProject } from '@core/project/document.js';
import { folderOf } from '@core/project/tree.js';

import { createProjectStore } from './projectStore.js';
import { useProgram } from './useProgram.js';
import { State } from './useToolpaths.js';

/** Deterministic ids. */
const counter = () => { let k = 0; return () => `n${(k += 1)}`; };

/** Whatever a generator that worked would have returned. */
const ok = (text = 'G21\nG90\n') => ({
	text, lines: text.split('\n'), blocks: [{ jobId: 'n5', name: 'Cut', from: 0, to: 1 }],
	warnings: [], blocked: [], stats: { cuts: 2, arcs: 0, rapids: 1, toolChanges: 0 },
});


/**
 * A store, a fake upstream, and the composable wired to both.
 *
 * @param {Function} [generate] - the generator to use
 * @returns {Object} everything the tests need
 */
function fixture(generate = vi.fn(async () => ok())) {

	const newId = counter();
	const project = createProject({ newId });
	const { document } = project;

	const tool = createNode(NodeType.TOOL, { name: 'Bit' }, { newId });
	const job = createNode(NodeType.JOB, { name: 'Cut' }, { newId });
	tool.children = [job.id];
	document.nodes[tool.id] = tool;
	document.nodes[job.id] = job;
	folderOf(document, FolderRole.JOBS).children.push(tool.id);

	const store = createProjectStore({ project });
	const toolpaths = shallowRef([]);
	const state = shallowRef(State.IDLE);
	const scope = effectScope();

	let api;
	scope.run(() => { api = useProgram({ store, toolpaths, state, generate }); });

	/** Lets the immediate watch and the generator's promise both land. */
	const settle = async () => {
		await nextTick();
		await new Promise((resolve) => { setTimeout(resolve, 0); });
	};

	return { store, toolpaths, state, generate, api, scope, settle };
}


describe('generating the program', () => {

	it('emits once as soon as it is created', async () => {
		const f = fixture();
		await f.settle();
		expect(f.generate).toHaveBeenCalledTimes(1);
		expect(f.api.text.value).toBe('G21\nG90\n');
	});

	it('re-emits when the toolpaths change, not when the document does', async () => {

		// The document changing is what makes the TOOLPATHS regenerate; following
		// it here too would emit from a set of toolpaths one edit behind.
		const f = fixture();
		await f.settle();

		f.store.select([f.store.document.root]);
		await f.settle();
		expect(f.generate).toHaveBeenCalledTimes(1);

		f.toolpaths.value = [{ jobId: 'n5', paths: [] }];
		await f.settle();
		expect(f.generate).toHaveBeenCalledTimes(2);
	});

	it('hands the generator the toolpaths it already has', async () => {
		const f = fixture();
		f.toolpaths.value = [{ jobId: 'n5', paths: [], depths: [] }];
		await f.settle();
		expect(f.generate).toHaveBeenLastCalledWith(f.store.project,
			expect.objectContaining({ toolpaths: f.toolpaths.value }));
	});
});


describe('staleness, which is the reason this is not a computed', () => {

	it('is not stale once the text matches the document', async () => {
		const f = fixture();
		await f.settle();
		expect(f.api.state.value).toBe(State.IDLE);
		expect(f.api.stale.value).toBe(false);
		expect(f.api.canExport.value).toBe(true);
	});

	it('is stale while the toolpaths upstream are still settling', async () => {

		// The window between a keystroke and the regeneration that follows it.
		// Small, real, and made real again every time the pipeline moves further
		// off the main thread.
		const f = fixture();
		await f.settle();

		f.state.value = State.QUEUED;
		await nextTick();

		expect(f.api.state.value).toBe(State.QUEUED);
		expect(f.api.stale.value).toBe(true);
		expect(f.api.canExport.value).toBe(false);
	});

	it('reports its own generation, not just the one upstream', async () => {
		let release;
		const generate = vi.fn(() => new Promise((resolve) => { release = () => resolve(ok()); }));
		const f = fixture(generate);
		await nextTick();

		expect(f.api.state.value).toBe(State.GENERATING);
		expect(f.api.canExport.value).toBe(false);

		release();
		await f.settle();
		expect(f.api.state.value).toBe(State.IDLE);
	});

	it('refuses to export a program that is blocked, even when it is current', async () => {
		const f = fixture(vi.fn(async () => ({
			text: '', lines: [], blocks: [], warnings: ['nope'], stats: null,
			blocked: [{ nodeId: 'n5', level: 'error', code: 'x', message: 'nope' }],
		})));
		await f.settle();
		expect(f.api.stale.value).toBe(false);
		expect(f.api.canExport.value).toBe(false);
	});
});


describe('when the generator throws', () => {

	it('drops the old text rather than leaving the wrong part on screen', async () => {

		// The one thing worse than no G-code is G-code for a part that is no
		// longer the one in front of you.
		let fail = false;
		const f = fixture(vi.fn(async () => {
			if (fail)
				throw new Error('clipper fell over');
			return ok();
		}));

		await f.settle();
		expect(f.api.text.value).not.toBe('');

		fail = true;
		f.toolpaths.value = [{ jobId: 'n5' }];
		await f.settle();

		expect(f.api.text.value).toBe('');
		expect(f.api.state.value).toBe(State.FAILED);
		expect(f.api.warnings.value).toEqual(['clipper fell over']);
		expect(f.api.canExport.value).toBe(false);
	});
});
