/**
 * @file vue-win-mgr-patches.test.js
 * @description Integration tests for the local patches to `vue-win-mgr`.
 *
 * `vue-win-mgr` is consumed as a `file:` dependency while we iterate on it, and
 * we added two APIs it did not have (plan.md 0.3):
 *
 *   - `@layout-changed` on WindowManager, so layout persistence has something to
 *     listen to instead of polling.
 *   - `windowCtx.isVisible` / `onVisibilityChange`, so canvas and WebGL windows
 *     can pause their render loops when hidden. Hidden tabs are kept alive with
 *     v-show, and nothing in the library throttles them.
 *
 * These run against the BUILT package, not its source, because the built package
 * is what the app actually imports. If a rebuild of the library ever drops one of
 * these, the failure shows up here rather than as a silently pegged CPU.
 *
 * Requires `npm run build` in ../Vue-Window-Manager first (see README).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, h, inject, onMounted } from 'vue';
import { WindowManager } from 'vue-win-mgr';

/**
 * A minimal window component that captures its injected contexts so the tests
 * can reach the very API surface a real window component would use.
 */
const Probe = {
	name: 'Probe',
	setup() {
		const windowCtx = inject('windowCtx');
		const frameCtx = inject('frameCtx');

		onMounted(() => {
			globalThis.__probes = globalThis.__probes || [];
			globalThis.__probes.push({ windowCtx, frameCtx });
		});

		return () => h('div', { class: 'probe' }, 'probe');
	},
};

beforeAll(() => {

	// jsdom implements neither of these, and the manager uses both
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};

	// the tab header measures label widths with a 2d canvas context
	HTMLCanvasElement.prototype.getContext = function () {
		return { font: '', measureText: (t) => ({ width: (t || '').length * 7 }) };
	};

	Element.prototype.getBoundingClientRect = function () {
		return { x: 0, y: 0, top: 0, left: 0, right: 1600, bottom: 1000, width: 1600, height: 1000, toJSON() {} };
	};
});

const availableWindows = [
	{ window: Probe, title: 'Probe A', slug: 'probeA' },
	{ window: Probe, title: 'Probe B', slug: 'probeB' },
];

/**
 * Builds a single-frame tabbed layout containing the given window slugs.
 *
 * @param {String[]} windows - slugs to place in the frame
 * @returns {Array} a vue-win-mgr layout array
 */
function tabbedLayout(windows) {
	return [
		{ name: 'window', top: 0, left: 0, bottom: 1000, right: 1600 },
		{ name: 'tabs', windows, style: 10, left: 0, right: 1600, top: 0, bottom: 1000 },
	];
}

/**
 * Mounts the manager and waits for the layout to finish settling.
 *
 * The library suppresses layout-changed for a settle window after startup, so
 * anything testing real changes has to wait past it first.
 *
 * @param {String[]} windows - slugs to place in the frame
 * @returns {Promise<Object>} the mounted wrapper
 */
async function mountSettled(windows) {

	globalThis.__probes = [];

	const wrapper = mount(WindowManager, {
		props: { availableWindows, defaultLayout: tabbedLayout(windows) },
		attachTo: document.body,
	});

	await settle(900);
	return wrapper;
}

/**
 * Flushes Vue's queue, waits real time, then flushes again.
 *
 * @param {Number} ms - milliseconds to wait
 * @returns {Promise<void>} resolves once settled
 */
async function settle(ms) {
	await nextTick();
	await new Promise((resolve) => setTimeout(resolve, ms));
	await nextTick();
}


describe('windowCtx.isVisible', () => {

	it('exposes the patched API on the injected contexts', async () => {

		const wrapper = await mountSettled(['probeA', 'probeB']);
		const [a] = globalThis.__probes;

		expect(a.windowCtx.isVisible, 'isVisible ref').toBeDefined();
		expect(typeof a.windowCtx.isVisible.value).toBe('boolean');
		expect(typeof a.windowCtx.onVisibilityChange).toBe('function');
		expect(typeof a.frameCtx.getActiveWindow).toBe('function');

		wrapper.unmount();
	});

	it('reports exactly one visible window in a tabbed frame', async () => {

		const wrapper = await mountSettled(['probeA', 'probeB']);
		const probes = globalThis.__probes;

		expect(probes.length, 'both windows mount even though one is hidden').toBe(2);

		const visible = probes.filter((p) => p.windowCtx.isVisible.value === true);
		expect(visible.length).toBe(1);

		wrapper.unmount();
	});

	it('agrees with frameCtx.getActiveWindow()', async () => {

		const wrapper = await mountSettled(['probeA', 'probeB']);
		const probes = globalThis.__probes;

		const visible = probes.filter((p) => p.windowCtx.isVisible.value === true);
		const active = probes[0].frameCtx.getActiveWindow();

		expect(active).not.toBeNull();
		expect(active.id).toBe(visible[0].windowCtx.id);

		wrapper.unmount();
	});

	it('reports a lone window in a frame as visible', async () => {

		const wrapper = await mountSettled(['probeA']);
		const [only] = globalThis.__probes;

		expect(only.windowCtx.isVisible.value).toBe(true);

		wrapper.unmount();
	});
});


describe('@layout-changed', () => {

	it('does not fire for the initial layout build', async () => {

		const wrapper = await mountSettled(['probeA']);

		// the container resize fits frames slightly after the manager reports
		// ready, so without an explicit settle window this would fire spuriously
		// on every app start
		expect(wrapper.emitted('layout-changed')).toBeUndefined();

		wrapper.unmount();
	});

	it('fires after a structural change, with a JSON-safe layout payload', async () => {

		const wrapper = await mountSettled(['probeA']);
		const { frameCtx } = globalThis.__probes[0];

		frameCtx.addWindow('probeB');

		// debounced, so nothing yet
		await settle(50);
		expect(wrapper.emitted('layout-changed')).toBeUndefined();

		await settle(400);
		const events = wrapper.emitted('layout-changed');

		expect(events, 'should have fired by now').toBeDefined();
		expect(events.length).toBe(1);

		const payload = events[0][0];
		expect(Array.isArray(payload)).toBe(true);
		expect(payload[0].name).toBe('window');
		expect(() => JSON.parse(JSON.stringify(payload))).not.toThrow();

		const listed = payload.filter((e) => Array.isArray(e.windows)).flatMap((f) => f.windows);
		expect(listed.length, 'both windows in the serialised layout').toBe(2);

		wrapper.unmount();
	});

	it('coalesces a burst of changes into a single emission', async () => {

		const wrapper = await mountSettled(['probeA']);
		const { frameCtx } = globalThis.__probes[0];

		// a splitter drag mutates position on every mouse-move; an app must not
		// serialise its layout sixty times a second
		frameCtx.addWindow('probeB');
		await settle(20);
		frameCtx.addWindow('probeA');
		await settle(20);
		frameCtx.addWindow('probeB');

		await settle(500);
		const events = wrapper.emitted('layout-changed');

		expect(events).toBeDefined();
		expect(events.length, 'three changes, one emission').toBe(1);

		wrapper.unmount();
	});
});
