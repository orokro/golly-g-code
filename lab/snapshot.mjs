/**
 * @file snapshot.mjs
 * @description Renders a static HTML report of the pipeline for one SVG file.
 *
 * Usage: node lab/snapshot.mjs <input.svg> [output.html]
 *
 * Produces a self-contained page that opens in any browser with no dev server,
 * which makes it the quickest way to actually LOOK at what the core produced
 * rather than trusting a test count.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runPipeline } from './pipeline.js';
import { renderReportHtml } from './report.js';

const input = process.argv[2];
const output = process.argv[3] ?? 'pipeline-report.html';

if (input === undefined) {
	console.error('usage: node lab/snapshot.mjs <input.svg> [output.html]');
	process.exit(1);
}

const svgText = fs.readFileSync(input, 'utf8');
const result = runPipeline(svgText, {
	toolDiameter: Number(process.env.TOOL_DIAMETER ?? 3.175),
});

fs.writeFileSync(output, renderReportHtml(result, {
	title: path.basename(input),
	showVertices: process.env.SHOW_VERTICES === '1',
}));

const { stats } = result;
console.log(`${input} -> ${output}`);
console.log(`  ${stats.shapes} shapes, ${stats.closed} closed + ${stats.open} open subpaths, ${stats.points} points`);
console.log(`  ${result.warnings.length} warning(s)`);
