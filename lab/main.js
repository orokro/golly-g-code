/**
 * @file main.js
 * @description Live geometry lab: drop an SVG, see what the core makes of it.
 */

import { runPipeline } from './pipeline.js';
import { renderSceneSvg, PALETTE } from './render.js';

const drop = document.getElementById('drop');
const file = document.getElementById('file');
const out = document.getElementById('out');
const toolInput = document.getElementById('tool');
const tolInput = document.getElementById('tol');
const vertsInput = document.getElementById('verts');
const dpiInput = document.getElementById('dpi');
const bySubInput = document.getElementById('bysub');
const offsetsInput = document.getElementById('offsets');
const subs = document.getElementById('subs');

/** The most recently loaded document, so the controls can re-run it. */
let currentSvg = null;


/**
 * Runs the pipeline on the loaded document and renders the result.
 *
 * @returns {void}
 */
function render() {

	if (currentSvg === null)
		return;

	let result;

	try {
		result = runPipeline(currentSvg, {
			toolDiameter: Number(toolInput.value) || 3.175,
			tolerance: Number(tolInput.value) || 0.01,
			pixelsPerInch: Number(dpiInput.value) || 96,
		});
	} catch (error) {
		out.innerHTML = `<p style="color:#e0798f">Import failed: ${error.message}</p>`;
		return;
	}

	const { stats, warnings } = result;

	const size = result.viewport.physical;

	// say plainly whether the size is known or assumed -- this is the difference
	// between a document that stated real units and one that did not
	const sizeText = size === null
		? 'size unknown'
		: `${size.width.toFixed(2)} × ${size.height.toFixed(2)} mm`
			+ (stats.dpiDependent
				? ` <span style="color:${PALETTE.sourceOpen}">(assumed @ ${stats.pixelsPerInch} px/in)</span>`
				: ' <span style="color:#7ee081">(stated by the file)</span>');

	const summary = `${sizeText} · ${stats.shapes} shapes · ${stats.closed} closed + `
		+ `<span style="color:${PALETTE.sourceOpen}">${stats.open} open</span> subpaths · `
		+ `${stats.points} points · import ${stats.importMs.toFixed(1)}ms, `
		+ `flatten ${stats.flattenMs.toFixed(1)}ms, offset ${stats.offsetMs.toFixed(1)}ms`;

	const warningList = warnings.length === 0
		? '<p style="color:#7ee081">no warnings</p>'
		: `<p style="color:#ffb347">${warnings.length} warning(s)</p><ul style="color:#ffb347">${
			warnings.map((w) => `<li>${w.replace(/</g, '&lt;')}</li>`).join('')}</ul>`;

	out.innerHTML = `<p>${summary}</p>${warningList}`
		+ `<div style="background:${PALETTE.background};border:1px solid #2a2a33;border-radius:6px;overflow:hidden">`
		+ renderSceneSvg(result, {
			showVertices: vertsInput.checked,
			colorBySubPath: bySubInput.checked,
			showOffsets: offsetsInput.checked,
		})
		+ '</div>';

	renderSubPathTable(result);
}


/**
 * Lists every subpath, so topology questions can be answered by looking.
 *
 * Two outlines that appear joined by a bridge are either one subpath containing
 * that bridge as a real segment, or two separate subpaths that merely touch.
 * The point count and the start marker tell you which.
 *
 * @param {Object} result - the pipeline result
 * @returns {void}
 */
function renderSubPathTable(result) {

	if (bySubInput.checked === false) {
		subs.innerHTML = '';
		return;
	}

	const rows = result.source.map((sub, index) => {
		const colour = `hsl(${(index * 47) % 360} 70% 62%)`;
		const start = sub.points[0] ?? [0, 0];
		const end = sub.points[sub.points.length - 1] ?? [0, 0];
		return `<tr>
			<td><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colour}"></span></td>
			<td>${index}</td>
			<td>${sub.closed ? 'closed' : '<b style="color:#ffb347">OPEN</b>'}</td>
			<td>${sub.points.length}</td>
			<td>${start[0].toFixed(2)}, ${start[1].toFixed(2)}</td>
			<td>${end[0].toFixed(2)}, ${end[1].toFixed(2)}</td>
		</tr>`;
	}).join('');

	subs.innerHTML = '<h2 style="font-size:13px;margin:22px 0 6px;color:#fff">subpaths</h2>'
		+ '<table style="border-collapse:collapse;font:inherit">'
		+ '<tr style="color:#7a7a86"><td></td><td>#</td><td>kind</td><td>points</td><td>start</td><td>end</td></tr>'
		+ rows + '</table>'
		+ '<style>#subs td{padding:2px 12px 2px 0}</style>';
}


/**
 * Loads a File object as the current document.
 *
 * @param {File} chosen - the dropped or selected file
 * @returns {void}
 */
function load(chosen) {

	const reader = new FileReader();
	reader.onload = () => {
		currentSvg = String(reader.result);
		drop.textContent = chosen.name;
		render();
	};
	reader.readAsText(chosen);
}

drop.addEventListener('click', () => file.click());
file.addEventListener('change', () => { if (file.files[0]) load(file.files[0]); });

drop.addEventListener('dragover', (event) => {
	event.preventDefault();
	drop.classList.add('over');
});

drop.addEventListener('dragleave', () => drop.classList.remove('over'));

drop.addEventListener('drop', (event) => {
	event.preventDefault();
	drop.classList.remove('over');
	if (event.dataTransfer.files[0])
		load(event.dataTransfer.files[0]);
});

for (const input of [toolInput, tolInput, vertsInput, dpiInput, bySubInput, offsetsInput])
	input.addEventListener('change', render);
