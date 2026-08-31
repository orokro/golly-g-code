/**
 * @file lines.js
 * @description The arithmetic behind showing a large program in a small window.
 *
 * Separated from the component for the usual reason — it is the part with edge
 * cases, and a component is the hardest place to test one.
 *
 * ---------------------------------------------------------------------------
 * Why a virtual list rather than a `<pre>`
 *
 * The bracket in the tests emits nine hundred lines. A sheet of parts with
 * pockets emits tens of thousands, and a rule of thumb worth stating is that
 * G-code line count grows with the flattening tolerance, so the file gets bigger
 * precisely when the user is being careful.
 *
 * One `<pre>` holding all of it is fine to paint and impossible to decorate: a
 * gutter and a highlighted job both need a box per line, and a hundred thousand
 * of those is where the window stops opening. So only the visible slice exists
 * in the DOM, and the scrollbar is given the right size by a single spacer.
 * ---------------------------------------------------------------------------
 */

/** Line height in CSS pixels. Fixed, because virtual scrolling needs it to be. */
export const LINE_HEIGHT = 18;

/** Extra lines rendered above and below, so a fast scroll does not show gaps. */
export const OVERSCAN = 10;


/**
 * Which lines to actually render.
 *
 * @param {Object} view - the scroll state
 * @param {Number} view.scrollTop - pixels scrolled
 * @param {Number} view.height - the visible height in pixels
 * @param {Number} view.count - how many lines there are in total
 * @param {Number} [view.lineHeight=LINE_HEIGHT] - pixels per line
 * @param {Number} [view.overscan=OVERSCAN] - extra lines each side
 * @returns {Object} `{ start, end, offset }` — a half-open range and the pixel
 *   offset to translate the rendered slice by
 */
export function visibleRange(view) {

	const {
		scrollTop = 0, height = 0, count = 0,
		lineHeight = LINE_HEIGHT, overscan = OVERSCAN,
	} = view ?? {};

	if (count <= 0 || lineHeight <= 0)
		return { start: 0, end: 0, offset: 0 };

	// Clamped to the content, not just to zero. A scroller keeps its scrollTop
	// when its content shrinks -- regenerate a 40,000 line program into a 900
	// line one and for a frame the window is scrolled a mile past the end. An
	// unclamped `first` puts `start` beyond `end`, the row loop produces nothing,
	// and the window is simply blank with no error anywhere.
	const first = Math.min(
		Math.floor(Math.max(0, scrollTop) / lineHeight),
		Math.max(0, count - 1));

	const visible = Math.ceil(Math.max(0, height) / lineHeight);

	const start = Math.max(0, first - overscan);
	const end = Math.min(count, first + visible + overscan + 1);

	return { start, end, offset: start * lineHeight };
}


/**
 * The block belonging to the current selection, if one does.
 *
 * Takes the FIRST selected job rather than trying to show several. Highlighting
 * two ranges at once is legible; scrolling to two at once is not, and this is
 * what the scroll follows.
 *
 * @param {Array<Object>} blocks - from the program's line map
 * @param {String[]} ids - the selected node ids
 * @returns {Object|null} the block, or null when nothing selected is a job
 */
export function blockFor(blocks, ids) {

	const wanted = new Set(ids ?? []);

	return (blocks ?? []).find((block) => wanted.has(block.jobId)) ?? null;
}


/**
 * Where to scroll so a line is on screen, or null when it already is.
 *
 * Only moves when it has to, and puts the target a third of the way down rather
 * than at the very top — a line pinned to the top edge has no context above it,
 * and the line above a job's first move is the comment naming the job.
 *
 * @param {Number} line - the line to reveal, zero based
 * @param {Object} view - `{ scrollTop, height, lineHeight }`
 * @returns {Number|null} the scrollTop to move to, or null to stay put
 */
export function scrollToLine(line, view) {

	const { scrollTop = 0, height = 0, lineHeight = LINE_HEIGHT } = view ?? {};

	if (!(line >= 0) || height <= 0)
		return null;

	const top = line * lineHeight;

	if (top >= scrollTop && top + lineHeight <= scrollTop + height)
		return null;

	return Math.max(0, top - Math.floor(height / 3));
}


/**
 * A one-line summary of the program, for the toolbar.
 *
 * @param {Object|null} stats - the emitter's move counts
 * @param {Number} lines - how many lines the program has
 * @returns {String} the summary
 */
export function summarise(stats, lines) {

	if (stats === null || stats === undefined)
		return `${lines} lines`;

	const parts = [`${lines} lines`, `${stats.cuts + stats.arcs} cutting moves`];

	if (stats.rapids > 0)
		parts.push(`${stats.rapids} rapids`);

	if (stats.toolChanges > 0)
		parts.push(`${stats.toolChanges} tool change${stats.toolChanges === 1 ? '' : 's'}`);

	return parts.join(' · ');
}
