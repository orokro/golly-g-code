import { describe, it, expect } from 'vitest';
import { LINE_HEIGHT, visibleRange, blockFor, scrollToLine, summarise } from './lines.js';

describe('the visible slice', () => {

	it('renders only what fits, plus the overscan', () => {
		const { start, end } = visibleRange({ scrollTop: 0, height: 180, count: 10_000, lineHeight: 18 });
		expect(start).toBe(0);
		// ten lines fit, plus ten overscan each side, and the partial line at the
		// bottom edge
		expect(end).toBe(21);
	});

	it('offsets the slice by exactly where it starts, so the text does not drift', () => {

		// The one that goes wrong: an offset computed from scrollTop rather than
		// from the first rendered line leaves the text a few pixels out at every
		// scroll position that is not a multiple of the line height.
		const { start, offset } = visibleRange({
			scrollTop: 1007, height: 200, count: 10_000, lineHeight: 18, overscan: 5,
		});
		expect(offset).toBe(start * 18);
	});

	it('never runs past the end of the program', () => {

		// A scroller keeps its scrollTop when its content shrinks. Regenerate a
		// long program into a short one and, for a frame, this is asked for a
		// slice a mile past the end -- and an unclamped answer puts `start` beyond
		// `end`, which renders no rows at all and no error either.
		const { start, end } = visibleRange({ scrollTop: 99_999, height: 200, count: 30, lineHeight: 18 });
		expect(end).toBe(30);
		expect(start).toBeLessThan(end);
	});

	it('renders nothing for an empty program', () => {
		expect(visibleRange({ scrollTop: 0, height: 400, count: 0 })).toEqual({ start: 0, end: 0, offset: 0 });
	});

	it('survives being asked before the window has a size', () => {
		const { start, end } = visibleRange({ scrollTop: 0, height: 0, count: 500 });
		expect(start).toBe(0);
		expect(end).toBeGreaterThan(0);
	});
});


describe('which block belongs to the selection', () => {

	const blocks = [
		{ jobId: 'a', name: 'A', from: 5, to: 40 },
		{ jobId: 'b', name: 'B', from: 41, to: 90 },
	];

	it('finds the selected job', () => {
		expect(blockFor(blocks, ['b'])?.name).toBe('B');
	});

	it('takes the first selected job when several are', () => {
		expect(blockFor(blocks, ['b', 'a'])?.name).toBe('A');
	});

	it('is null when the selection is not a job', () => {
		expect(blockFor(blocks, ['some-path'])).toBe(null);
		expect(blockFor(blocks, [])).toBe(null);
		expect(blockFor([], ['a'])).toBe(null);
	});
});


describe('scrolling to a line', () => {

	it('stays put when the line is already on screen', () => {
		expect(scrollToLine(10, { scrollTop: 0, height: 400, lineHeight: 18 })).toBe(null);
	});

	it('puts the line a third of the way down, not at the very edge', () => {
		const to = scrollToLine(500, { scrollTop: 0, height: 300, lineHeight: 18 });
		expect(to).toBe(500 * 18 - 100);
	});

	it('does not scroll above the top of the program', () => {
		expect(scrollToLine(1, { scrollTop: 5000, height: 300, lineHeight: 18 })).toBe(0);
	});

	it('counts the bottom edge as off screen', () => {
		// a line whose last pixel is below the fold has to be scrolled to, which
		// a `>=` on the wrong side of the comparison gets wrong by one line
		const view = { scrollTop: 0, height: 36, lineHeight: 18 };
		expect(scrollToLine(1, view)).toBe(null);
		expect(scrollToLine(2, view)).not.toBe(null);
	});
});


describe('the toolbar summary', () => {

	it('counts arcs as cutting moves, not as something else', () => {
		expect(summarise({ cuts: 90, arcs: 10, rapids: 4, toolChanges: 0 }, 120))
			.toBe('120 lines · 100 cutting moves · 4 rapids');
	});

	it('mentions a tool change, singular', () => {
		expect(summarise({ cuts: 1, arcs: 0, rapids: 1, toolChanges: 1 }, 9))
			.toMatch(/1 tool change$/);
	});

	it('says only the line count before there are any stats', () => {
		expect(summarise(null, 0)).toBe('0 lines');
	});
});


describe('the line height', () => {

	it('is a number the CSS and the arithmetic both use', () => {
		// stated here so a change to one without the other is a failing test
		// rather than text that drifts a pixel per line down a long program
		expect(LINE_HEIGHT).toBe(18);
	});
});
