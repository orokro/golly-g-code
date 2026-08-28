import { describe, it, expect } from 'vitest';
import { reconcile, useWindowState } from './useWindowState.js';

const defaults = { zoom: 1, panX: 0, panY: 0, grid: true, label: 'none', tags: [] };


describe('deciding what to trust from a saved layout', () => {

	it('takes values that match the defaults', () => {
		expect(reconcile({ zoom: 2.5, panX: -40, grid: false }, defaults))
			.toMatchObject({ zoom: 2.5, panX: -40, grid: false, panY: 0 });
	});

	it('falls back for a field that changed type between builds', () => {
		// a saved "1" multiplies into a string rather than throwing, and the
		// symptom appears several layers from the cause
		expect(reconcile({ zoom: '1' }, defaults).zoom).toBe(1);
		expect(reconcile({ grid: 'yes' }, defaults).grid).toBe(true);
		expect(reconcile({ label: 42 }, defaults).label).toBe('none');
	});

	it('REFUSES NaN and Infinity, which survive every operation they touch', () => {
		expect(reconcile({ zoom: NaN }, defaults).zoom).toBe(1);
		expect(reconcile({ panX: Infinity }, defaults).panX).toBe(0);
		expect(reconcile({ panY: -Infinity }, defaults).panY).toBe(0);
	});

	it('keeps an array only where an array was expected', () => {
		expect(reconcile({ tags: ['a'] }, defaults).tags).toEqual(['a']);
		expect(reconcile({ tags: { 0: 'a' } }, defaults).tags).toEqual([]);
		expect(reconcile({ label: ['a'] }, defaults).label).toBe('none');
	});

	it('drops fields this build does not know about', () => {
		const out = reconcile({ zoom: 2, removedInThisRelease: 99 }, defaults);
		expect(out.zoom).toBe(2);
		expect(Object.hasOwn(out, 'removedInThisRelease')).toBe(false);
	});

	it('returns the defaults for anything that is not an object', () => {
		for (const saved of [null, undefined, 42, 'nope', [], true])
			expect(reconcile(saved, defaults)).toEqual(defaults);
	});

	it('never hands back the defaults object itself', () => {
		// a view mutating its own state must not rewrite the defaults for the
		// next window that restores
		const out = reconcile({}, defaults);
		expect(out).not.toBe(defaults);
		out.zoom = 9;
		expect(defaults.zoom).toBe(1);
	});

	it('accepts zero and empty string, which are values not absences', () => {
		expect(reconcile({ zoom: 0, label: '' }, defaults))
			.toMatchObject({ zoom: 0, label: '' });
	});
});


describe('the composable', () => {

	/** Captures the callbacks the window manager would have registered. */
	const rig = () => {
		const hooks = {};
		return {
			register: (fn) => { hooks.serialize = fn; },
			restore: (fn) => { hooks.load = fn; },
			hooks,
		};
	};

	it('starts at the defaults', () => {
		const r = rig();
		expect(useWindowState(defaults, r)).toMatchObject(defaults);
	});

	it('serialises what the view has changed', () => {
		const r = rig();
		const state = useWindowState(defaults, r);

		state.zoom = 3;
		state.panX = 120;

		expect(r.hooks.serialize()).toMatchObject({ zoom: 3, panX: 120 });
	});

	it('serialises a plain object, not a reactive proxy', () => {
		const r = rig();
		useWindowState(defaults, r);
		const snapshot = r.hooks.serialize();

		expect(() => JSON.stringify(snapshot)).not.toThrow();
		expect(JSON.parse(JSON.stringify(snapshot))).toMatchObject(defaults);
	});

	it('updates in place when a layout is restored, so the view stays reactive', () => {
		const r = rig();
		const state = useWindowState(defaults, r);

		r.hooks.load({ zoom: 4, panY: -12 });

		expect(state.zoom).toBe(4);
		expect(state.panY).toBe(-12);
	});

	it('restores through the same filter, not raw', () => {
		const r = rig();
		const state = useWindowState(defaults, r);

		r.hooks.load({ zoom: NaN, panX: 'far' });

		expect(state.zoom).toBe(1);
		expect(state.panX).toBe(0);
	});

	it('survives a layout with nothing saved for this window', () => {
		const r = rig();
		const state = useWindowState(defaults, r);
		expect(() => r.hooks.load(undefined)).not.toThrow();
		expect(state).toMatchObject(defaults);
	});
});
