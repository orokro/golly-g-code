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
		});
	} catch (error) {
		out.innerHTML = `<p style="color:#e0798f">Import failed: ${error.message}</p>`;
		return;
	}

	const { stats, warnings } = result;

	const summary = `${stats.shapes} shapes · ${stats.closed} closed + `
		+ `<span style="color:${PALETTE.sourceOpen}">${stats.open} open</span> subpaths · `
		+ `${stats.points} points · import ${stats.importMs.toFixed(1)}ms, `
		+ `flatten ${stats.flattenMs.toFixed(1)}ms, offset ${stats.offsetMs.toFixed(1)}ms`;

	const warningList = warnings.length === 0
		? '<p style="color:#7ee081">no warnings</p>'
		: `<p style="color:#ffb347">${warnings.length} warning(s)</p><ul style="color:#ffb347">${
			warnings.map((w) => `<li>${w.replace(/</g, '&lt;')}</li>`).join('')}</ul>`;

	out.innerHTML = `<p>${summary}</p>${warningList}`
		+ `<div style="background:${PALETTE.background};border:1px solid #2a2a33;border-radius:6px;overflow:hidden">`
		+ renderSceneSvg(result, { showVertices: vertsInput.checked })
		+ '</div>';
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

for (const input of [toolInput, tolInput, vertsInput])
	input.addEventListener('change', render);
