/**
 * @file open-offset.mjs
 * @description Renders a comparison of the open-path offset strategies.
 *
 * Usage: node lab/open-offset.mjs <in.svg> [out.html] [offsetMm]
 *
 * The fold filter is the sort of thing that is easy to write, easy to test for
 * the property it guarantees, and still quietly wrong to look at. This puts the
 * raw offset and the cleaned one side by side on real artwork so the difference
 * is visible rather than inferred.
 */

import fs from 'node:fs';
import path from 'node:path';
import { importSvgDocument } from '../src/core/svg/document.js';
import { flattenSubPath } from '../src/core/path/flatten.js';
import { offsetAlongNormals, offsetByHeading, Side } from '../src/core/cam/openOffset.js';

const input = process.argv[2];
const output = process.argv[3] ?? 'open-offset.html';
const OFFSET = Number(process.argv[4] ?? 1.5875);

if (input === undefined) {
	console.error('usage: node lab/open-offset.mjs <in.svg> [out.html] [offsetMm]');
	process.exit(1);
}

const { shapes, viewport } = importSvgDocument(fs.readFileSync(input, 'utf8'), {
	pixelsPerInch: Number(process.env.DPI ?? 96),
});

/** Every open subpath in the document, flattened. */
const openPaths = [];
for (const shape of shapes)
	for (const sub of shape.subPaths)
		if (sub.closed === false)
			openPaths.push({ label: shape.label, points: flattenSubPath(sub, { tolerance: 0.02 }).points });

if (openPaths.length === 0) {
	console.error('no open subpaths in that file');
	process.exit(1);
}

const d = (pts) => (pts.length === 0 ? '' : 'M' + pts.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L'));

const bboxOf = (sets) => {
	const pts = sets.flat();
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};

/**
 * One labelled panel, drawn in millimetre space with y flipped for display.
 *
 * @param {String} title - panel heading
 * @param {String} note - explanatory line beneath the heading
 * @param {Array<Object>} layers - `{ pts, colour, width, dash, dots }` per layer, drawn in order
 * @param {Object} box - bounds shared by every panel, so they are all at one scale
 * @returns {String} a `<figure>` element
 */
function panel(title, note, layers, box) {

	const pad = OFFSET * 3 + 2;
	const view = [box.minX - pad, box.minY - pad,
		(box.maxX - box.minX) + (pad * 2), (box.maxY - box.minY) + (pad * 2)];
	const hair = Math.max(view[2], view[3]) / 1100;

	const body = layers.map(({ pts, colour, width, dash, dots }) => {
		const stroke = `<path d="${d(pts)}" fill="none" stroke="${colour}" stroke-width="${hair * (width ?? 2)}"`
			+ (dash ? ` stroke-dasharray="${hair * 6} ${hair * 4}"` : '') + '/>';
		const marks = dots
			? pts.map(([x, y]) => `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${hair * 2}" fill="${colour}"/>`).join('')
			: '';
		return stroke + marks;
	}).join('');

	return `<figure><figcaption><b>${title}</b><br><span>${note}</span></figcaption>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.join(' ')}">
<g transform="translate(0 ${(view[1] * 2) + view[3]}) scale(1 -1)">${body}</g></svg></figure>`;
}

const SOURCE = '#5ec8d8';
const RAW = '#e0798f';
const CLEAN = '#7ee081';
const HEAD = '#c792ea';

const sections = [];
const timings = [];

for (const { label, points } of openPaths) {

	const t0 = performance.now();
	const raw = offsetAlongNormals(points, OFFSET, { side: Side.LEFT, clean: 0 });
	const cleaned = offsetAlongNormals(points, OFFSET, { side: Side.LEFT, clean: 1 });
	const partial = offsetAlongNormals(points, OFFSET, { side: Side.LEFT, clean: 0.5 });
	const other = offsetAlongNormals(points, OFFSET, { side: Side.RIGHT, clean: 1 });
	const ms = performance.now() - t0;

	timings.push(`${label}: ${points.length} pts, 4 offsets in ${ms.toFixed(1)} ms`);

	const heading = offsetByHeading(points, OFFSET * 4, Math.PI / 2);
	const box = bboxOf([points, raw.points, other.points, heading]);

	sections.push(`<h2>${label} <span class="dim">${points.length} points</span></h2><div class="grid">
${panel('Heading offset', `Whole path moved ${(OFFSET * 4).toFixed(1)} mm at 90°. Shape preserved exactly; cannot fold.`,
	[{ pts: points, colour: SOURCE, width: 1.6, dash: true }, { pts: heading, colour: HEAD, width: 2.2 }], box)}
${panel('Normal offset, clean = 0', `Raw. Every point pushed ${OFFSET} mm along its normal. Inside of tight bends folds over itself.`,
	[{ pts: points, colour: SOURCE, width: 1.6, dash: true }, { pts: raw.points, colour: RAW, width: 2.2 }], box)}
${panel('clean = 0.5', `${partial.removed} of ${raw.points.length} points removed. Partial tidy-up.`,
	[{ pts: points, colour: SOURCE, width: 1.6, dash: true }, { pts: partial.points, colour: CLEAN, width: 2.2 }], box)}
${panel('clean = 1', `${cleaned.removed} of ${raw.points.length} points removed. Nothing left closer than ${OFFSET} mm to the source.`,
	[{ pts: points, colour: SOURCE, width: 1.6, dash: true }, { pts: cleaned.points, colour: CLEAN, width: 2.2 }], box)}
${panel('Other side, clean = 1', `Side B. ${other.removed} removed — the outside of a bend spreads rather than folding.`,
	[{ pts: points, colour: SOURCE, width: 1.6, dash: true }, { pts: other.points, colour: CLEAN, width: 2.2 }], box)}
${panel('Raw vs cleaned', 'Both together. Pink is what the filter discarded.',
	[{ pts: raw.points, colour: RAW, width: 1.4 }, { pts: cleaned.points, colour: CLEAN, width: 2.2 },
		{ pts: points, colour: SOURCE, width: 1.2, dash: true }], box)}
</div>`);
}

fs.writeFileSync(output, `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Open-path offsets — ${path.basename(input)}</title><style>
 :root{color-scheme:dark}
 body{margin:0;padding:26px;background:#0f0f12;color:#d7d7de;font:13px/1.6 ui-monospace,Menlo,Consolas,monospace}
 h1{font-size:15px;margin:0 0 4px;color:#fff}
 h2{font-size:13px;margin:26px 0 10px;color:#fff;font-weight:600}
 .dim{color:#7a7a86;font-weight:400}
 .lead{color:#8a8a95;margin:0 0 6px;max-width:80ch}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:16px}
 figure{margin:0;background:#16161a;border:1px solid #2a2a33;border-radius:6px;padding:11px}
 figcaption{margin-bottom:8px;min-height:3.4em}
 figcaption span{color:#8a8a95}
 svg{width:100%;height:auto;display:block}
 .meta{color:#7a7a86;margin-top:20px}
</style></head><body>
<h1>Open-path offsets — ${path.basename(input)}</h1>
<p class="lead">Offset ${OFFSET} mm (a ${(OFFSET * 2).toFixed(3)} mm tool). Document ${viewport.physical.width.toFixed(1)} × ${viewport.physical.height.toFixed(1)} mm${viewport.dpiDependent ? ` — size assumed at ${viewport.pixelsPerInch} px/in` : ''}.</p>
${sections.join('')}
<p class="meta">${timings.join('<br>')}</p>
</body></html>`);

console.log(`${input} -> ${output}`);
for (const line of timings) console.log('  ' + line);
