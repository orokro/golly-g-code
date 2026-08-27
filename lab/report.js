/**
 * @file report.js
 * @description Wraps a pipeline result in a readable HTML page.
 *
 * Used by the snapshot script to produce a file that opens anywhere, with no
 * dev server and no build step.
 */

import { renderSceneSvg, PALETTE } from './render.js';

/**
 * Escapes text for safe inclusion in HTML.
 *
 * @param {String} text - raw text
 * @returns {String} escaped text
 */
function escapeHtml(text) {

	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}


/**
 * Renders a full HTML report for a pipeline result.
 *
 * @param {Object} result - the value returned by `runPipeline`
 * @param {Object} [options] - options
 * @param {String} [options.title='Pipeline'] - heading for the page
 * @param {Boolean} [options.showVertices=false] - dot every flattened point
 * @returns {String} a complete HTML document
 */
export function renderReportHtml(result, options = {}) {

	const { title = 'Pipeline', showVertices = false } = options;
	const { stats, viewport, warnings } = result;

	const svg = renderSceneSvg(result, { showVertices });

	const rows = [
		['source', title],
		['GEOMETRY extent', result.extent
			? `${result.extent.width.toFixed(2)} × ${result.extent.height.toFixed(2)} mm  `
				+ `(x ${result.extent.minX.toFixed(2)}..${result.extent.maxX.toFixed(2)}, `
				+ `y ${result.extent.minY.toFixed(2)}..${result.extent.maxY.toFixed(2)})`
			: 'no geometry'],
		['document size', viewport.physical
			? `${viewport.physical.width.toFixed(2)} × ${viewport.physical.height.toFixed(2)} mm`
			: 'unknown'],
		['size came from', viewport.source
			+ (viewport.dpiDependent ? ` (ASSUMED at ${viewport.pixelsPerInch} px/inch)` : ' (stated by the file)')],
		['scale', `${viewport.scaleX.toFixed(6)} mm per user unit`],
		['shapes', String(stats.shapes)],
		['subpaths', `${stats.closed} closed, ${stats.open} open`],
		['flattened points', String(stats.points)],
		['flatten tolerance', `${stats.tolerance} mm`],
		['tool', `⌀ ${stats.toolDiameter} mm`],
		['timings', `import ${stats.importMs.toFixed(1)} ms · flatten ${stats.flattenMs.toFixed(1)} ms · offset ${stats.offsetMs.toFixed(1)} ms`],
	];

	const legend = [
		[PALETTE.source, 'closed subpath (as drawn)'],
		[PALETTE.sourceOpen, 'OPEN subpath — jscut would silently close this'],
		[PALETTE.outward, 'outward offset by tool radius'],
		[PALETTE.inward, 'inward offset by tool radius'],
	];

	return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>GollyGCode — ${escapeHtml(title)}</title>
<style>
	:root { color-scheme: dark; }
	body { margin:0; padding:24px; background:#0f0f12; color:#d7d7de;
	       font:13px/1.6 ui-monospace, Menlo, Consolas, monospace; }
	h1 { font-size:15px; margin:0 0 2px; font-weight:600; color:#fff; }
	.sub { color:#7a7a86; margin:0 0 20px; }
	.wrap { display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:24px; align-items:start; }
	@media (max-width: 900px) { .wrap { grid-template-columns:minmax(0,1fr); } }
	.stage { background:${PALETTE.background}; border:1px solid #2a2a33; border-radius:6px; overflow:hidden; }
	table { border-collapse:collapse; width:100%; }
	td { padding:3px 0; vertical-align:top; }
	td:first-child { color:#7a7a86; padding-right:12px; white-space:nowrap; }
	.legend { margin-top:18px; }
	.legend div { display:flex; align-items:center; gap:8px; padding:2px 0; }
	.swatch { width:16px; height:3px; border-radius:2px; flex:none; }
	.warn { margin-top:18px; color:#ffb347; }
	.warn ul { margin:4px 0 0; padding-left:18px; }
	.ok { margin-top:18px; color:#7ee081; }
</style></head><body>
<h1>GollyGCode — CAM core</h1>
<p class="sub">SVG → normalize → flatten → offset. Rendered from the real pipeline output.</p>
<div class="wrap">
	<div class="stage">${svg}</div>
	<div>
		<table>${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
		<div class="legend">${legend.map(([c, l]) =>
			`<div><span class="swatch" style="background:${c}"></span><span>${escapeHtml(l)}</span></div>`).join('')}</div>
		${warnings.length === 0
			? '<div class="ok">no warnings</div>'
			: `<div class="warn">${warnings.length} warning(s)<ul>${
				warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`}
	</div>
</div>
</body></html>`;
}
