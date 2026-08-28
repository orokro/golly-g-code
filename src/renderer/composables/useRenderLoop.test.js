import { describe, it, expect, vi } from 'vitest';
import { ref, nextTick } from 'vue';
import { useRenderLoop } from './useRenderLoop.js';
import { createRenderDriver } from './renderDriver.js';

/** A fake requestAnimationFrame with a clock we control. */
const fakeFrames = () => {
	let next = 1;
	let pending = null;
	let now = 0;
	return {
		requestFrame: (fn) => { pending = { id: next, fn }; return next++; },
		cancelFrame: (id) => { if (pending?.id === id) pending = null; },
		tick(ms = 16) { now += ms; const due = pending; pending = null; due?.fn(now); return due !== null; },
		get scheduled() { return pending !== null; },
	};
};


describe('joining a view to the loop', () => {

	it('STARTS THE LOOP when a view that began hidden becomes visible', async () => {
		// The bug this file exists for. Views register during setup, before the
		// window manager has laid anything out, so everything reports hidden.
		// The driver correctly declines to schedule — and without this watch,
		// nothing ever asks it again. Every counter sits at zero, forever, with
		// no error and every unit test passing.
		const frames = fakeFrames();
		const driver = createRenderDriver(frames);
		const visible = ref(false);
		const render = vi.fn();

		useRenderLoop(render, { driver, visible, label: 'view' });

		expect(frames.scheduled).toBe(false);

		visible.value = true;
		await nextTick();

		expect(frames.scheduled).toBe(true);
		frames.tick();
		expect(render).toHaveBeenCalledTimes(1);
	});

	it('runs immediately for a view that is already visible', async () => {
		const frames = fakeFrames();
		const driver = createRenderDriver(frames);
		const render = vi.fn();

		useRenderLoop(render, { driver, visible: ref(true), label: 'view' });
		await nextTick();

		frames.tick();
		expect(render).toHaveBeenCalledTimes(1);
	});

	it('stops being called while hidden, and resumes after', async () => {
		const frames = fakeFrames();
		const driver = createRenderDriver(frames);
		const visible = ref(true);
		const render = vi.fn();

		useRenderLoop(render, { driver, visible, label: 'view' });
		await nextTick();
		frames.tick();
		expect(render).toHaveBeenCalledTimes(1);

		visible.value = false;
		await nextTick();
		frames.tick();
		expect(render).toHaveBeenCalledTimes(1);
		expect(frames.scheduled).toBe(false);

		visible.value = true;
		await nextTick();
		frames.tick();
		expect(render).toHaveBeenCalledTimes(2);
	});

	it('wakes the loop for a second view when the first is hidden', async () => {
		const frames = fakeFrames();
		const driver = createRenderDriver(frames);
		const first = ref(true);
		const second = ref(false);
		const secondRender = vi.fn();

		useRenderLoop(() => {}, { driver, visible: first, label: 'first' });
		useRenderLoop(secondRender, { driver, visible: second, label: 'second' });
		await nextTick();

		first.value = false;
		await nextTick();
		frames.tick();
		expect(frames.scheduled).toBe(false);

		second.value = true;
		await nextTick();
		frames.tick();
		expect(secondRender).toHaveBeenCalledTimes(1);
	});

	it('says so rather than silently never rendering when there is no driver', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { stop } = useRenderLoop(() => {}, { driver: null, visible: ref(true), label: 'orphan' });

		expect(warn).toHaveBeenCalled();
		expect(() => stop()).not.toThrow();
		warn.mockRestore();
	});
});
