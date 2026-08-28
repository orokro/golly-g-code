import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { useVisible, createVisibilityWatcher, VisibilitySource } from './useVisible.js';


describe('when the window manager knows', () => {

	it('uses the context, and says so', () => {
		const isVisible = ref(true);
		const { visible, source } = useVisible(null, { windowCtx: { isVisible } });

		expect(visible.value).toBe(true);
		expect(source.value).toBe(VisibilitySource.CONTEXT);
	});

	it('follows the context as it changes', () => {
		const isVisible = ref(true);
		const { visible } = useVisible(null, { windowCtx: { isVisible } });

		isVisible.value = false;
		expect(visible.value).toBe(false);

		isVisible.value = true;
		expect(visible.value).toBe(true);
	});
});


describe('when it does not', () => {

	// "assume visible" is the tempting default and the wrong one: it restores
	// exactly the problem the flag exists to prevent, with no symptom except a
	// warm laptop, which nobody reports as a bug.

	it('reports that it is only assuming, rather than claiming to know', () => {
		const { visible, source } = useVisible(null, { windowCtx: null });
		expect(visible.value).toBe(true);
		expect(source.value).toBe(VisibilitySource.ASSUMED);
	});

	it('watches intersection instead when there is an element', () => {
		let fire = null;
		const observe = (callback) => {
			fire = callback;
			return { observe: () => {}, disconnect: () => {} };
		};
		const onChange = vi.fn();
		const watcher = createVisibilityWatcher(onChange, { observe });

		expect(watcher.attach({})).toBe(true);

		fire([{ isIntersecting: false, intersectionRatio: 0 }]);
		expect(onChange).toHaveBeenLastCalledWith(false);

		fire([{ isIntersecting: true, intersectionRatio: 1 }]);
		expect(onChange).toHaveBeenLastCalledWith(true);
	});

	it('treats a partial sliver as visible, since it is being looked at', () => {
		let fire = null;
		const observe = (callback) => {
			fire = callback;
			return { observe: () => {}, disconnect: () => {} };
		};
		const onChange = vi.fn();
		createVisibilityWatcher(onChange, { observe }).attach({});

		fire([{ isIntersecting: undefined, intersectionRatio: 0.01 }]);
		expect(onChange).toHaveBeenLastCalledWith(true);
	});

	it('cannot attach without an element, and admits it', () => {
		const watcher = createVisibilityWatcher(vi.fn(), { observe: () => ({}) });
		expect(watcher.attach(null)).toBe(false);
	});

	it('disconnects when detached', () => {
		const disconnect = vi.fn();
		const observe = () => ({ observe: () => {}, disconnect });
		const watcher = createVisibilityWatcher(vi.fn(), { observe });

		watcher.attach({});
		watcher.detach();

		expect(disconnect).toHaveBeenCalledTimes(1);
	});
});
