/**
 * @file tabs.mjs
 * @description Shows holding tabs on a real toolpath, at several tool diameters.
 *
 * Usage: node lab/tabs.mjs <in.svg> [out.html]
 *
 * The claim being checked is the one jscut gets wrong: a tab is a width of
 * MATERIAL in a place on the PART, so changing the cutter must not move it or
 * resize it. That is easy to assert in a test and easy to believe wrongly, so
 * the same tabs are drawn at four tool diameters on one set of axes.
 *
 * The strip under each plan view is the Z the tool holds along the path, which
 * is where a tab actually lives — the plan view alone cannot show it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { importSvgDocument } from '../src/core/svg/document.js';
import { flattenSubPath } from '../src/core/path/flatten.js';
import { offsetAlongNormals, Side } from '../src/core/cam/openOffset.js';
import { arcLengths, placeTabs, splitAtTabs, tabZ } from '../src/core/cam/tabs.js';
import { computeDepthPasses } from '../src/core/cam/depth.js';

const input = process.argv[2];
const output = process.argv[3] ?? 'tabs.html';

if (input === undefined) {
	console.error('usage: node lab/tabs.mjs <in.svg> [out.html]');
	process.exit(1);
}

const THICKNESS = 18;
const TAB_HEIGHT = 3;
const TAB_LENGTH = 8;
const PASS_DEPTH = 6;
const RADII = [0.5, 1.5875, 3, 6];
const TABS = [0.15, 0.4, 0.62, 0.85].map((position) => ({ position, length: TAB_LENGTH }));

const SOURCE = '#3d4a52';
const CUT = '#7ee081';
const TAB = '#e8b64c';

const d = (pts) => 'M' + pts.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L');
const lengthOf = (p) => arcLengths(p)[p.length - 1];

/**
 * Plan view of one toolpath with its tabs picked out.
 *
 * @param {Array<Number[]>} source - the source path
 * @param {Array<Object>} runs - the split toolpath
 * @param {Object} box - shared bounds
 * @returns {String} an `<svg>`
 */
function planView(source, runs, box) {

	const pad = 9;
	const view = [box.minX - pad, box.minY - pad,
		(box.maxX - box.minX) + (pad * 2), (box.maxY - box.minY) + (pad * 2)];
	const hair = Math.max(view[2], view[3]) / 900;

	const body = [`<path d="${d(source)}" fill="none" stroke="${SOURCE}" stroke-width="${hair * 1.4}"/>`]
		.concat(runs.map(({ points, overTab }) =>
			`<path d="${d(points)}" fill="none" stroke="${overTab ? TAB : CUT}"`
			+ ` stroke-width="${hair * (overTab ? 4.5 : 2.2)}" stroke-linecap="round"/>`))
		.join('');

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.join(' ')}">
<g transform="translate(0 ${(view[1] * 2) + view[3]}) scale(1 -1)">${body}</g></svg>`;
}

/**
 * Z the tool holds along the path, for every depth pass — a side elevation.
 *
 * @param {Array<Object>} runs - the split toolpath
 * @param {Number[]} passes - Z of each depth pass
 * @returns {String} an `<svg>`
 */
function depthView(runs, passes) {

	const total = runs.reduce((sum, r) => sum + lengthOf(r.points), 0);
	const view = [0, -THICKNESS - 2, total, THICKNESS + 4];
	const hair = total / 900;

	const stock = `<rect x="0" y="${-THICKNESS}" width="${total}" height="${THICKNESS}"`
		+ ` fill="#1d1d22" stroke="#2a2a33" stroke-width="${hair}"/>`;

	const lines = passes.map((passZ) => {
		const pts = [];
		let at = 0;
		for (const { points, overTab } of runs) {
			const run = lengthOf(points);
			const { z } = overTab ? tabZ(passZ, TAB_HEIGHT, THICKNESS) : { z: passZ };
			pts.push([at, z], [at + run, z]);
			at += run;
		}
		return `<path d="${d(pts)}" fill="none" stroke="${CUT}" stroke-width="${hair * 1.8}"/>`;
	}).join('');

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.join(' ')}">
<g transform="translate(0 ${(view[1] * 2) + view[3]}) scale(1 -1)">${stock}${lines}</g></svg>`;
}

const { shapes } = importSvgDocument(fs.readFileSync(input, 'utf8'), {
	pixelsPerInch: Number(process.env.DPI ?? 96),
});

const passes = computeDepthPasses(THICKNESS, PASS_DEPTH);
const sections = [];

for (const shape of shapes) {
	for (const sub of shape.subPaths) {

		if (sub.closed !== false)
			continue;

		const source = flattenSubPath(sub, { tolerance: 0.02 }).points;
		const panels = [];

		for (const radius of RADII) {

			const { path: toolpath } = offsetAlongNormals(source, radius, { side: Side.LEFT });
			if (toolpath.length < 2)
				continue;

			const { spans, warnings } = placeTabs(source, toolpath, TABS, { toolRadius: radius });
			const runs = splitAtTabs(toolpath, spans);

			const all = [...source, ...toolpath];
			const box = {
				minX: Math.min(...all.map((p) => p[0])), maxX: Math.max(...all.map((p) => p[0])),
				minY: Math.min(...all.map((p) => p[1])), maxY: Math.max(...all.map((p) => p[1])),
			};

			const widths = spans.map((s) => (s.end - s.start).toFixed(2)).join(', ');

			panels.push(`<figure><figcaption><b>${(radius * 2).toFixed(3)} mm tool</b><br>
<span>${spans.length} tabs. The tool is lifted for ${widths} mm of travel to leave each
${TAB_LENGTH} mm bridge — less than ${TAB_LENGTH} where the line doubles back inside the
cut, more where it bows outward.`
			+ `${warnings.length ? `<br><b class="warn">${warnings.join('<br>')}</b>` : ''}</span></figcaption>
${planView(source, runs, box)}${depthView(runs, passes)}</figure>`);
		}

		if (panels.length > 0)
			sections.push(`<h2>${shape.label}</h2><div class="grid">${panels.join('')}</div>`);
	}
}

fs.writeFileSync(output, `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Holding tabs — ${path.basename(input)}</title><style>
 :root{color-scheme:dark}
 body{margin:0;padding:26px;background:#0f0f12;color:#d7d7de;font:13px/1.6 ui-monospace,Menlo,Consolas,monospace}
 h1{font-size:15px;margin:0 0 4px;color:#fff}
 h2{font-size:13px;margin:26px 0 10px;color:#fff;font-weight:600}
 .lead{color:#8a8a95;margin:0 0 14px;max-width:88ch}
 .grid{display:grid;grid-template-columns:1fr;gap:14px}
 figure{margin:0;background:#16161a;border:1px solid #2a2a33;border-radius:6px;padding:11px}
 figcaption{margin-bottom:8px}
 figcaption span{color:#8a8a95}
 svg{width:100%;height:auto;display:block}
 svg+svg{margin-top:6px}
 b.cut{color:#7ee081}b.tab{color:#e8b64c}
 b.warn{color:#e0798f;font-weight:400}
</style></head><body>
<h1>Holding tabs — ${path.basename(input)}</h1>
<p class="lead">${TABS.length} tabs, ${TAB_LENGTH} mm wide and ${TAB_HEIGHT} mm tall, in
${THICKNESS} mm stock cut in ${passes.length} passes. The same four tabs at four tool
diameters: they must not move and must not change width, because a tab is a piece of the
PART. <b class="cut">Green</b> is cutting, <b class="tab">amber</b> is riding over a tab.
The strip below each plan view is the Z the tool holds along the path — a plan view alone
cannot show a tab.</p>
${sections.join('')}
</body></html>`);

console.log(`${input} -> ${output}`);
