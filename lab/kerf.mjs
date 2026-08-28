/**
 * @file kerf.mjs
 * @description What the cut will actually look like in the material.
 *
 * Usage: node lab/kerf.mjs <in.svg> [out.html]
 *
 * Every other view in this lab draws toolpaths — lines the tool centre follows.
 * That is the wrong picture for judging a drawing, because the tool is not a
 * pen. Greg: *"My main goal is to make the bit follow the path I drew, and the
 * width of the cut will show me what detail I'll actually get IRL."*
 *
 * So this draws the KERF: everything the cutter removes, filled. One edge of it
 * is the line as drawn (that is what a one-sided offset means); the other is a
 * tool diameter away. Where the drawing has detail finer than the bit, the kerf
 * swallows it, and that is visible here and nowhere else.
 *
 * Nothing here is a warning. A bit too fat for some of the detail is a normal
 * thing to decide about by looking, not something to be told.
 */

import fs from 'node:fs';
import path from 'node:path';
import { importSvgDocument } from '../src/core/svg/document.js';
import { flattenSubPath } from '../src/core/path/flatten.js';
import { offsetAlongNormals, Side } from '../src/core/cam/openOffset.js';
import { offsetOpen, OpenEnd } from '../src/core/geometry/clipper.js';

const input = process.argv[2];
const output = process.argv[3] ?? 'kerf.html';
const DIAMETERS = [0.8, 1.5875, 3.175, 6.35];

if (input === undefined) {
	console.error('usage: node lab/kerf.mjs <in.svg> [out.html]');
	process.exit(1);
}

const STOCK = '#c9a227';
const CUT = '#17171b';
const LINE = '#5ec8d8';

const ring = (pts) => 'M' + pts.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L') + 'Z';
const open = (pts) => 'M' + pts.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L');

/**
 * One panel: the stock, the material the cutter removes, and the drawn line.
 *
 * @param {String} title - heading
 * @param {String} note - sub-heading
 * @param {Array<Array<Number[]>>} kerf - rings of removed material
 * @param {Array<Number[]>} source - the line as drawn
 * @param {Object} box - shared bounds
 * @returns {String} a `<figure>`
 */
function panel(title, note, kerf, source, box) {

	const pad = 6;
	const view = [box.minX - pad, box.minY - pad,
		(box.maxX - box.minX) + (pad * 2), (box.maxY - box.minY) + (pad * 2)];
	const hair = Math.max(view[2], view[3]) / 1400;

	// even-odd so an enclosed island of untouched stock reads as stock
	const removed = `<path d="${kerf.map(ring).join(' ')}" fill="${CUT}" fill-rule="evenodd"/>`;
	const drawn = `<path d="${open(source)}" fill="none" stroke="${LINE}"`
		+ ` stroke-width="${hair * 1.1}" opacity="0.9"/>`;

	return `<figure><figcaption><b>${title}</b><br><span>${note}</span></figcaption>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.join(' ')}">
<rect x="${view[0]}" y="${view[1]}" width="${view[2]}" height="${view[3]}" fill="${STOCK}"/>
<g transform="translate(0 ${(view[1] * 2) + view[3]}) scale(1 -1)">${removed}${drawn}</g></svg></figure>`;
}

const { shapes, viewport } = importSvgDocument(fs.readFileSync(input, 'utf8'), {
	pixelsPerInch: Number(process.env.DPI ?? 96),
});

const sections = [];

for (const shape of shapes) {
	for (const sub of shape.subPaths) {

		if (sub.closed !== false)
			continue;

		const source = flattenSubPath(sub, { tolerance: 0.02 }).points;
		const panels = [];

		for (const diameter of DIAMETERS) {

			const radius = diameter / 2;
			const { path: toolpath } = offsetAlongNormals(source, radius, { side: Side.LEFT });

			if (toolpath.length < 2)
				continue;

			// the cutter sweeps a full radius either side of the path it follows
			const kerf = offsetOpen([toolpath], radius, {
				end: OpenEnd.ROUND,
				toleranceMm: 0.01,
			});

			const all = [...source, ...kerf.flat()];
			const box = {
				minX: Math.min(...all.map((p) => p[0])), maxX: Math.max(...all.map((p) => p[0])),
				minY: Math.min(...all.map((p) => p[1])), maxY: Math.max(...all.map((p) => p[1])),
			};

			panels.push(panel(`${diameter} mm bit`,
				`${(diameter / 25.4).toFixed(4)}″ — the cut is ${diameter} mm wide`,
				kerf, source, box));
		}

		if (panels.length > 0)
			sections.push(`<h2>${shape.label}</h2><div class="grid">${panels.join('')}</div>`);
	}
}

fs.writeFileSync(output, `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>What the cut looks like — ${path.basename(input)}</title><style>
 :root{color-scheme:dark}
 body{margin:0;padding:26px;background:#0f0f12;color:#d7d7de;font:13px/1.6 ui-monospace,Menlo,Consolas,monospace}
 h1{font-size:15px;margin:0 0 4px;color:#fff}
 h2{font-size:13px;margin:26px 0 10px;color:#fff;font-weight:600}
 .lead{color:#8a8a95;margin:0 0 14px;max-width:88ch}
 .grid{display:grid;grid-template-columns:1fr;gap:14px}
 figure{margin:0;background:#16161a;border:1px solid #2a2a33;border-radius:6px;padding:11px}
 figcaption{margin-bottom:8px}
 figcaption span{color:#8a8a95}
 svg{width:100%;height:auto;display:block;border-radius:3px}
</style></head><body>
<h1>What the cut looks like — ${path.basename(input)}</h1>
<p class="lead">Not toolpaths — the material actually removed, at four bit sizes. Yellow is
stock, dark is cut away, and the thin blue line is the drawing. The bit follows one side of
that line, so the line is one edge of the cut and the other edge is a bit diameter away.
Where the drawing is finer than the bit, the cut swallows it. Document
${viewport.physical.width.toFixed(1)} × ${viewport.physical.height.toFixed(1)} mm.</p>
${sections.join('')}
</body></html>`);

console.log(`${input} -> ${output}`);
