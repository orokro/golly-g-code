/**
 * @file link.mjs
 * @description Renders the moves BETWEEN cuts, which are normally invisible.
 *
 * Usage: node lab/link.mjs <in.svg> [out.html] [offsetMm]
 *
 * A toolpath report usually draws only the cutting. The lifts, rapids and
 * plunges that join one cut to the next are left to the imagination, which is
 * how an ordering that looks sensible on paper turns out to zig-zag across the
 * work five times. Greg asked to see them, so this draws them: cuts solid,
 * travel dashed, a mark at every plunge, and the order numbered.
 *
 * It was built to compare orderings, and what it showed instead was that there
 * was nothing to order: one side of an open path is one cut. It stays as the
 * check that this is still true, and as the prototype for the Workspace's
 * travel layer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { importSvgDocument } from '../src/core/svg/document.js';
import { flattenSubPath } from '../src/core/path/flatten.js';
import { offsetBothSides } from '../src/core/cam/openOffset.js';

const input = process.argv[2];
const output = process.argv[3] ?? 'link.html';
const OFFSET = Number(process.argv[4] ?? 1.5875);
const TOOL = OFFSET * 2;

if (input === undefined) {
	console.error('usage: node lab/link.mjs <in.svg> [out.html] [offsetMm]');
	process.exit(1);
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Total length of a polyline, in millimetres.
 *
 * @param {Array<Number[]>} pts - the polyline
 * @returns {Number} the length
 */
function lengthOf(pts) {
	let total = 0;
	for (let i = 0; i + 1 < pts.length; i++)
		total += dist(pts[i], pts[i + 1]);
	return total;
}





/**
 * Turns an ordering into the moves a machine would actually make.
 *
 * @param {Array<Array<Number[]>>} pieces - cuts in the order they run
 * @param {Number[]} from - where the tool starts
 * @returns {Object} `{ travels, cuts, rapid, plunges }`
 */
function plan(pieces, from) {
	const travels = [];
	let at = from;
	for (const piece of pieces) {
		travels.push([at, piece[0]]);
		at = piece[piece.length - 1];
	}
	return {
		travels,
		cuts: pieces,
		rapid: travels.reduce((sum, [a, b]) => sum + dist(a, b), 0),
		plunges: pieces.length,
	};
}


// ---------------------------------------------------------------- rendering

const SOURCE = '#3d4a52';
const CUT = '#7ee081';
const TRAVEL = '#e0798f';
const PLUNGE = '#e8b64c';

const d = (pts) => 'M' + pts.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L');

/**
 * One panel: the cuts, the travel between them, and the order.
 *
 * @param {String} title - heading
 * @param {Object} made - the result of plan()
 * @param {Array<Number[]>} source - the source path, drawn faint for reference
 * @param {Object} box - shared bounds
 * @returns {String} a `<figure>`
 */
function panel(title, made, source, box) {

	const pad = OFFSET * 3 + 2;
	const view = [box.minX - pad, box.minY - pad,
		(box.maxX - box.minX) + (pad * 2), (box.maxY - box.minY) + (pad * 2)];
	const hair = Math.max(view[2], view[3]) / 1100;

	const faint = `<path d="${d(source)}" fill="none" stroke="${SOURCE}" stroke-width="${hair * 1.4}"/>`;

	const travel = made.travels.map(([a, b]) =>
		`<path d="${d([a, b])}" fill="none" stroke="${TRAVEL}" stroke-width="${hair * 2.1}"`
		+ ` stroke-dasharray="${hair * 7} ${hair * 5}" stroke-linecap="round"/>`).join('');

	const cuts = made.cuts.map((piece) =>
		`<path d="${d(piece)}" fill="none" stroke="${CUT}" stroke-width="${hair * 2.4}"`
		+ ' stroke-linecap="round" stroke-linejoin="round"/>').join('');

	// a plunge is where the tool goes down: the start of every cut
	const plunges = made.cuts.map((piece) =>
		`<circle cx="${piece[0][0].toFixed(2)}" cy="${piece[0][1].toFixed(2)}" r="${hair * 4}"`
		+ ` fill="none" stroke="${PLUNGE}" stroke-width="${hair * 1.6}"/>`).join('');

	// numbers must be counter-flipped, since the whole group is drawn y-up
	const order = made.cuts.map((piece, i) =>
		`<g transform="translate(${(piece[0][0] + (OFFSET * 1.2)).toFixed(2)} ${piece[0][1].toFixed(2)}) scale(1 -1)">`
		+ `<text x="0" y="0" fill="${PLUNGE}" font-size="${hair * 13}"`
		+ ` font-family="ui-monospace,monospace">${i + 1}</text></g>`).join('');

	return `<figure><figcaption><b>${title}</b><br><span>`
		+ `${made.plunges} plunge${made.plunges === 1 ? '' : 's'}`
		+ ` · ${made.rapid.toFixed(0)} mm travelled between cuts`
		+ `</span></figcaption>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.join(' ')}">
<g transform="translate(0 ${(view[1] * 2) + view[3]}) scale(1 -1)">${faint}${travel}${cuts}${plunges}${order}</g></svg></figure>`;
}

// ---------------------------------------------------------------- the report

const { shapes, viewport } = importSvgDocument(fs.readFileSync(input, 'utf8'), {
	pixelsPerInch: Number(process.env.DPI ?? 96),
});

const sections = [];

for (const shape of shapes) {
	for (const sub of shape.subPaths) {

		if (sub.closed !== false)
			continue;

		const source = flattenSubPath(sub, { tolerance: 0.02 }).points;
		const { left } = offsetBothSides(source, OFFSET, { tolerance: 0.005 });

		if (left.length === 0)
			continue;

		// one side is now ONE cut, so there is nothing left to order -- what this
		// page shows is that fact: a single plunge and no travel between cuts
		const cuts = [left];

		const start = [Math.min(...source.map((p) => p[0])), Math.max(...source.map((p) => p[1]))];

		const xs = [...source, ...left].map((p) => p[0]);
		const ys = [...source, ...left].map((p) => p[1]);
		const box = {
			minX: Math.min(...xs), maxX: Math.max(...xs),
			minY: Math.min(...ys), maxY: Math.max(...ys),
		};

		sections.push(`<h2>${shape.label} <span class="dim">${lengthOf(left).toFixed(0)} mm of cut</span></h2><div class="grid">
${panel('One side, one cut', plan(cuts, start), source, box)}
</div>`);
	}
}

fs.writeFileSync(output, `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Cut order and travel — ${path.basename(input)}</title><style>
 :root{color-scheme:dark}
 body{margin:0;padding:26px;background:#0f0f12;color:#d7d7de;font:13px/1.6 ui-monospace,Menlo,Consolas,monospace}
 h1{font-size:15px;margin:0 0 4px;color:#fff}
 h2{font-size:13px;margin:26px 0 10px;color:#fff;font-weight:600}
 .dim{color:#7a7a86;font-weight:400}
 .lead{color:#8a8a95;margin:0 0 6px;max-width:86ch}
 .key{color:#8a8a95;margin:0 0 14px}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
 figure{margin:0;background:#16161a;border:1px solid #2a2a33;border-radius:6px;padding:11px}
 figcaption{margin-bottom:8px;min-height:2.8em}
 figcaption span{color:#8a8a95}
 svg{width:100%;height:auto;display:block}
 b.cut{color:#7ee081}b.travel{color:#e0798f}b.plunge{color:#e8b64c}
</style></head><body>
<h1>Cut order and travel — ${path.basename(input)}</h1>
<p class="lead">The moves between cuts, which a toolpath drawing normally leaves out.
Offset ${OFFSET} mm, a ${TOOL.toFixed(3)} mm tool. Document
${viewport.physical.width.toFixed(1)} × ${viewport.physical.height.toFixed(1)} mm.</p>
<p class="key"><b class="cut">green</b> cutting ·
<b class="travel">dashed pink</b> travelling between cuts ·
<b class="plunge">amber ring and number</b> where the tool goes down, and in what order</p>
${sections.join('')}
</body></html>`);

console.log(`${input} -> ${output}`);
