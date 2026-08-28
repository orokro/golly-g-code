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
import { arcLengths, placeTabs, planPass, tabBreaks } from '../src/core/cam/tabs.js';
import { computeDepthPasses } from '../src/core/cam/depth.js';

const input = process.argv[2];
const output = process.argv[3] ?? 'tabs.html';

if (input === undefined) {
	console.error('usage: node lab/tabs.mjs <in.svg> [out.html]');
	process.exit(1);
}

// Greg's worked example: 4mm stock cut 5mm to go through into the spoilboard,
// 1mm passes. Tabs at mixed depths so the different break-points are visible.
const THICKNESS = 4;
const CUT_DEPTH = 5;
const PASS_DEPTH = 1;
const SAFE_Z = 2;
const RADII = [0.5, 1.5875, 3, 6];
// Hand-picked, on straight-ish stretches, which is how they get placed for real
// (D17) -- not spread evenly by position. Mixed depths so the different
// break-points are visible.
const TABS = [
	{ position: 0.055, length: 8, depth: 3 },
	{ position: 0.30, length: 8, depth: 3 },
	{ position: 0.52, length: 12, depth: 1 },
	{ position: 0.955, length: 8, depth: 0 },
];

const SOURCE = '#3d4a52';
const CUT = '#7ee081';
const TAB = '#e8b64c';

const d = (pts) => 'M' + pts.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L');

/**
 * Plan view of one toolpath, showing where the deepest pass is broken.
 *
 * @param {Array<Number[]>} source - the source path
 * @param {Array<Object>} runs - the runs cut on the deepest pass
 * @param {Array<Number[]>} toolpath - the whole toolpath, for the gaps
 * @param {Object} box - shared bounds
 * @returns {String} an `<svg>`
 */
function planView(source, runs, toolpath, box) {

	const pad = 9;
	const view = [box.minX - pad, box.minY - pad,
		(box.maxX - box.minX) + (pad * 2), (box.maxY - box.minY) + (pad * 2)];
	const hair = Math.max(view[2], view[3]) / 900;

	const body = [
		`<path d="${d(source)}" fill="none" stroke="${SOURCE}" stroke-width="${hair * 1.4}"/>`,
		// the whole toolpath faint, so the breaks read as gaps in something
		`<path d="${d(toolpath)}" fill="none" stroke="${TAB}" stroke-width="${hair * 4.5}"`
		+ ' opacity="0.55" stroke-linecap="round"/>',
	]
		.concat(runs.map(({ points }) =>
			`<path d="${d(points)}" fill="none" stroke="${CUT}"`
			+ ` stroke-width="${hair * 2.2}" stroke-linecap="round"/>`))
		.join('');

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.join(' ')}">
<g transform="translate(0 ${(view[1] * 2) + view[3]}) scale(1 -1)">${body}</g></svg>`;
}

/**
 * Side elevation: where the tool is at cutting depth, pass by pass.
 *
 * The vertical hops are the breaks — retract to safe Z, rapid across the tab,
 * plunge, carry on. Everything a plan view cannot show about a tab is here.
 *
 * @param {Array<Number[]>} toolpath - the toolpath
 * @param {Array<Object>} spans - the tab spans
 * @param {Number[]} passes - Z of each depth pass
 * @returns {String} an `<svg>`
 */
function depthView(toolpath, spans, passes) {

	const total = arcLengths(toolpath)[toolpath.length - 1];

	// 5mm of depth across half a metre of path is a flat line. Z is exaggerated
	// so the passes and the breaks are separable; X stays true to scale, and the
	// caption says so rather than letting the picture imply a shape it does not
	// have.
	const zoom = (total / 14) / (CUT_DEPTH + SAFE_Z);
	const z = (value) => value * zoom;

	const view = [0, z(-CUT_DEPTH) - z(1), total, z(CUT_DEPTH + SAFE_Z) + z(2)];
	const hair = total / 900;

	const stock = `<rect x="0" y="${z(-THICKNESS)}" width="${total}" height="${z(THICKNESS)}"`
		+ ` fill="#1d1d22" stroke="#2a2a33" stroke-width="${hair}"/>`;

	// what is left standing under each tab
	const bridges = spans.map(({ start, end, depth }) =>
		`<rect x="${start}" y="${z(-THICKNESS)}" width="${end - start}"`
		+ ` height="${z(Math.max(0, THICKNESS - depth))}" fill="${TAB}" opacity="0.45"/>`).join('');

	const lines = passes.map((passZ) => {
		const runs = planPass(toolpath, spans, passZ);
		const pts = [[0, z(SAFE_Z)]];
		for (const { start, end } of runs)
			pts.push([start, z(SAFE_Z)], [start, z(passZ)], [end, z(passZ)], [end, z(SAFE_Z)]);
		pts.push([total, z(SAFE_Z)]);
		return `<path d="${d(pts)}" fill="none" stroke="${CUT}" stroke-width="${hair * 1.4}"/>`;
	}).join('');

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.join(' ')}">
<g transform="translate(0 ${(view[1] * 2) + view[3]}) scale(1 -1)">${stock}${bridges}${lines}</g></svg>`;
}

const { shapes } = importSvgDocument(fs.readFileSync(input, 'utf8'), {
	pixelsPerInch: Number(process.env.DPI ?? 96),
});

const passes = computeDepthPasses(CUT_DEPTH, PASS_DEPTH);
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
			const deepest = planPass(toolpath, spans, passes[passes.length - 1]);

			const all = [...source, ...toolpath];
			const box = {
				minX: Math.min(...all.map((p) => p[0])), maxX: Math.max(...all.map((p) => p[0])),
				minY: Math.min(...all.map((p) => p[1])), maxY: Math.max(...all.map((p) => p[1])),
			};

			const detail = spans.map(({ start, end, depth }) => {
				const breaksOn = passes.filter((z) => tabBreaks(z, depth)).length;
				return `${(end - start).toFixed(1)}mm at ${depth}mm deep`
					+ ` (breaks ${breaksOn} of ${passes.length} passes,`
					+ ` leaves ${(THICKNESS - depth).toFixed(1)}mm standing)`;
			}).join('; ');

			panels.push(`<figure><figcaption><b>${(radius * 2).toFixed(3)} mm tool</b><br>
<span>${detail}`
			+ `${warnings.length ? `<br><b class="warn">${warnings.join('<br>')}</b>` : ''}</span></figcaption>
${planView(source, deepest, toolpath, box)}${depthView(toolpath, spans, passes)}</figure>`);
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
<p class="lead">${THICKNESS} mm stock cut ${CUT_DEPTH} mm — through, into the spoilboard —
in ${passes.length} passes of ${PASS_DEPTH} mm. Four tabs at mixed depths, so they break
different passes: two at 3 mm, one at 1 mm, one at 0 mm which is never cut at all.
A tab is a <b>break</b>: full retract, rapid across, plunge, carry on.
<br><br>Plan view: <b class="cut">green</b> is cut on the deepest pass,
<b class="tab">amber</b> is the gaps left. Side elevation: the stock, the
<b class="tab">material standing</b> under each tab, and the tool's Z for every pass —
each hop is a break. Z is exaggerated in that strip, since ${CUT_DEPTH} mm of depth across
half a metre of path is otherwise a flat line; X is true to scale. The same tabs are shown at four cutter diameters, because a tab is a
piece of the PART and must not move or resize when the cutter changes.</p>
${sections.join('')}
</body></html>`);

console.log(`${input} -> ${output}`);
