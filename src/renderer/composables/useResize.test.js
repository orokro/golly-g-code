import { describe, it, expect, vi } from 'vitest';
import { resolveSize, createSizeWatcher, MAX_PIXEL_RATIO } from './useResize.js';


describe('what counts as a size', () => {

	it('reports an ordinary box', () => {
		expect(resolveSize(800, 600)).toMatchObject({
			width: 800, height: 600, bufferWidth: 800, bufferHeight: 600, pixelRatio: 1,
		});
	});

	it('REFUSES a zero, which is what a hidden element reports', () => {
		// the whole reason this module exists. setSize(0,0) gives an aspect of
		// NaN, a projection matrix of NaN, and a scene that silently vanishes and
		// never comes back — with no error anywhere
		expect(resolveSize(0, 0)).toBeNull();
		expect(resolveSize(800, 0)).toBeNull();
		expect(resolveSize(0, 600)).toBeNull();
	});

	it('refuses a box that rounds away to nothing', () => {
		expect(resolveSize(0.4, 600)).toBeNull();
		expect(resolveSize(800, 0.99)).toBeNull();
	});

	it('refuses NaN and Infinity, which arrive from unsettled layout', () => {
		expect(resolveSize(NaN, 600)).toBeNull();
		expect(resolveSize(800, Infinity)).toBeNull();
		expect(resolveSize(undefined, 600)).toBeNull();
	});

	it('floors a fractional box rather than handing on a fraction', () => {
		expect(resolveSize(800.7, 600.2)).toMatchObject({ width: 800, height: 600 });
	});

	it('scales the drawing buffer by the pixel ratio', () => {
		expect(resolveSize(400, 300, { pixelRatio: 2 }))
			.toMatchObject({ width: 400, height: 300, bufferWidth: 800, bufferHeight: 600 });
	});

	it('CLAMPS the pixel ratio, because fill rate is not free', () => {
		// a 3x buffer costs nine times the fill of a 1x one to be slightly
		// sharper, and this has to stay usable on a 2017 MacBook
		const size = resolveSize(400, 300, { pixelRatio: 3 });
		expect(size.pixelRatio).toBe(MAX_PIXEL_RATIO);
		expect(size.bufferWidth).toBe(400 * MAX_PIXEL_RATIO);
	});

	it('never scales below 1, whatever the display claims', () => {
		expect(resolveSize(400, 300, { pixelRatio: 0.5 }).pixelRatio).toBe(1);
		expect(resolveSize(400, 300, { pixelRatio: NaN }).pixelRatio).toBe(1);
	});

	it('keeps the buffer at least one pixel', () => {
		const size = resolveSize(1, 1, { pixelRatio: 1 });
		expect(size.bufferWidth).toBeGreaterThanOrEqual(1);
		expect(size.bufferHeight).toBeGreaterThanOrEqual(1);
	});
});


describe('watching an element', () => {

	/** An element whose size we control, and a ResizeObserver we can fire. */
	const rig = (width = 800, height = 600) => {
		let fire = null;
		const element = {
			box: { width, height },
			getBoundingClientRect() { return this.box; },
		};
		const observe = (callback) => {
			fire = callback;
			return { observe: () => {}, disconnect: () => { fire = null; } };
		};
		return { element, observe, resize(w, h) { element.box = { width: w, height: h }; fire?.(); },
			get attached() { return fire !== null; } };
	};

	it('reports the size as soon as it attaches', () => {
		const { element, observe } = rig();
		const onSize = vi.fn();
		createSizeWatcher(onSize, { observe, getPixelRatio: () => 1 }).attach(element);

		expect(onSize).toHaveBeenCalledTimes(1);
		expect(onSize.mock.calls[0][0]).toMatchObject({ width: 800, height: 600 });
	});

	it('reports again when the element actually changes size', () => {
		const r = rig();
		const onSize = vi.fn();
		createSizeWatcher(onSize, { observe: r.observe, getPixelRatio: () => 1 }).attach(r.element);

		r.resize(1024, 768);
		expect(onSize).toHaveBeenCalledTimes(2);
	});

	it('does NOT report when the observer fires without a real change', () => {
		// ResizeObserver fires for style changes that moved nothing, and a
		// Three.js resize reallocates buffers, so repeating one is not free
		const r = rig();
		const onSize = vi.fn();
		createSizeWatcher(onSize, { observe: r.observe, getPixelRatio: () => 1 }).attach(r.element);

		r.resize(800, 600);
		r.resize(800.4, 600.4);

		expect(onSize).toHaveBeenCalledTimes(1);
	});

	it('stays silent while the element is hidden, and keeps its last good size', () => {
		const r = rig();
		const onSize = vi.fn();
		const watcher = createSizeWatcher(onSize, { observe: r.observe, getPixelRatio: () => 1 });
		watcher.attach(r.element);

		r.resize(0, 0);

		expect(onSize).toHaveBeenCalledTimes(1);
		expect(watcher.last).toMatchObject({ width: 800, height: 600 });
	});

	it('reports again on being shown at a different size', () => {
		const r = rig();
		const onSize = vi.fn();
		const watcher = createSizeWatcher(onSize, { observe: r.observe, getPixelRatio: () => 1 });
		watcher.attach(r.element);

		r.resize(0, 0);
		r.resize(500, 400);

		expect(onSize).toHaveBeenCalledTimes(2);
		expect(watcher.last).toMatchObject({ width: 500, height: 400 });
	});

	it('does not report on being shown again at the SAME size', () => {
		const r = rig();
		const onSize = vi.fn();
		createSizeWatcher(onSize, { observe: r.observe, getPixelRatio: () => 1 }).attach(r.element);

		r.resize(0, 0);
		r.resize(800, 600);

		expect(onSize).toHaveBeenCalledTimes(1);
	});

	it('detaches cleanly and forgets what it knew', () => {
		const r = rig();
		const watcher = createSizeWatcher(vi.fn(), { observe: r.observe, getPixelRatio: () => 1 });
		watcher.attach(r.element);
		watcher.detach();

		expect(r.attached).toBe(false);
		expect(watcher.last).toBeNull();
	});

	it('does nothing when handed no element', () => {
		const onSize = vi.fn();
		const watcher = createSizeWatcher(onSize);
		expect(() => watcher.attach(null)).not.toThrow();
		expect(watcher.measure()).toBeNull();
		expect(onSize).not.toHaveBeenCalled();
	});
});
