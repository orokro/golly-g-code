import { describe, it, expect, vi } from 'vitest';
import { createRenderDriver } from './renderDriver.js';

/**
 * A fake requestAnimationFrame with a clock we control.
 *
 * The whole point of keeping the driver free of Vue: its behaviour is about
 * WHEN frames are requested, and that is only checkable by holding the clock.
 */
const fakeFrames = () => {
	let next = 1;
	let pending = null;
	let now = 0;

	return {
		requestFrame: (fn) => { pending = { id: next, fn }; return next++; },
		cancelFrame: (id) => { if (pending?.id === id) pending = null; },
		/** Runs the pending frame, if any, after advancing the clock. */
		tick(ms = 16) {
			now += ms;
			const due = pending;
			pending = null;
			if (due !== null)
				due.fn(now);
			return due !== null;
		},
		get scheduled() { return pending !== null; },
	};
};


describe('the render driver', () => {

	it('does not schedule anything until a view is registered', () => {
		const frames = fakeFrames();
		createRenderDriver(frames);
		expect(frames.scheduled).toBe(false);
	});

	it('runs a registered view every frame', () => {
		const frames = fakeFrames();
		const driver = createRenderDriver(frames);
		const render = vi.fn();

		driver.add(render);
		frames.tick();
		frames.tick();

		expect(render).toHaveBeenCalledTimes(2);
	});

	it('STOPS REQUESTING FRAMES when every view is hidden', () => {
		// the point of the whole module. A window hidden behind a tab inside the
		// window manager is not throttled by the browser the way a hidden tab is,
		// so a view that keeps rendering keeps burning a core.
		const frames = fakeFrames();
		const driver = createRenderDriver(frames);
		let visible = true;
		const render = vi.fn();

		driver.add(render, { isVisible: () => visible });
		frames.tick();
		expect(render).toHaveBeenCalledTimes(1);

		visible = false;
		frames.tick();

		expect(frames.scheduled).toBe(false);
		expect(driver.state.running).toBe(false);
		expect(render).toHaveBeenCalledTimes(1);
	});

	it('picks back up when something becomes visible again', () => {
		const frames = fakeFrames();
		const driver = createRenderDriver(frames);
		let visible = false;
		const render = vi.fn();

		driver.add(render, { isVisible: () => visible });
		expect(frames.scheduled).toBe(false);

		visible = true;
		driver.wake();
		frames.tick();

		expect(render).toHaveBeenCalledTimes(1);
	});

	it('keeps running for the visible views while others are hidden', () => {
		const frames = fakeFrames();
		const driver = createRenderDriver(frames);
		const shown = vi.fn();
		const hidden = vi.fn();

		driver.add(shown, { isVisible: () => true });
		driver.add(hidden, { isVisible: () => false });
		frames.tick();

		expect(shown).toHaveBeenCalledTimes(1);
		expect(hidden).not.toHaveBeenCalled();
		expect(driver.state).toMatchObject({ registered: 2, live: 1 });
	});

	it('hands the first frame a zero delta, not the length of the idle', () => {
		// waking after a minute hidden must not tell a view a minute passed, or
		// anything driven by delta jumps
		const frames = fakeFrames();
		const driver = createRenderDriver(frames);
		const seen = [];

		driver.add((delta) => seen.push(delta));
		frames.tick(16);
		frames.tick(16);

		expect(seen[0]).toBe(0);
		expect(seen[1]).toBeCloseTo(0.016, 6);
	});

	it('starts a fresh delta after idling rather than a huge one', () => {
		const frames = fakeFrames();
		const driver = createRenderDriver(frames);
		let visible = true;
		const seen = [];

		driver.add((delta) => seen.push(delta), { isVisible: () => visible });
		frames.tick(16);
		frames.tick(16);

		visible = false;
		frames.tick(60_000);

		visible = true;
		driver.wake();
		frames.tick(16);

		expect(seen[seen.length - 1]).toBe(0);
	});

	it('drops a view that throws instead of taking the loop down with it', () => {
		const frames = fakeFrames();
		const onError = vi.fn();
		const driver = createRenderDriver({ ...frames, onError });
		const healthy = vi.fn();

		driver.add(() => { throw new Error('bad view'); }, { label: 'broken' });
		driver.add(healthy);

		frames.tick();
		frames.tick();

		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][1]).toBe('broken');
		expect(healthy).toHaveBeenCalledTimes(2);
	});

	it('stops scheduling once the last view is removed', () => {
		const frames = fakeFrames();
		const driver = createRenderDriver(frames);

		const remove = driver.add(() => {});
		frames.tick();
		expect(frames.scheduled).toBe(true);

		remove();
		expect(frames.scheduled).toBe(false);
		expect(driver.state.registered).toBe(0);
	});

	it('removing one view leaves the others running', () => {
		const frames = fakeFrames();
		const driver = createRenderDriver(frames);
		const kept = vi.fn();

		const remove = driver.add(() => {});
		driver.add(kept);

		remove();
		frames.tick();

		expect(kept).toHaveBeenCalledTimes(1);
	});

	it('stop() forgets everything and cancels the pending frame', () => {
		const frames = fakeFrames();
		const driver = createRenderDriver(frames);

		driver.add(() => {});
		driver.stop();

		expect(frames.scheduled).toBe(false);
		expect(driver.state).toMatchObject({ registered: 0, live: 0, running: false });
	});
});
