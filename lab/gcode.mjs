/**
 * @file gcode.mjs
 * @description The whole pipeline, end to end: SVG in, G-code out.
 *
 * Usage: node lab/gcode.mjs <in.svg> [out.nc]
 *
 * Everything before this has been geometry checked against pictures and tests.
 * This is the first point where the program produces the thing the machine
 * actually eats, so it is also the first point where a whole-pipeline mistake
 * has nowhere left to hide.
 */

import fs from 'node:fs';
import path from 'node:path';
import { importSvgDocument } from '../src/core/svg/document.js';
import { flattenSubPath } from '../src/core/path/flatten.js';
import { offsetAlongNormals, Side } from '../src/core/cam/openOffset.js';
import { placeTabs, planPass } from '../src/core/cam/tabs.js';
import { computeDepthPasses } from '../src/core/cam/depth.js';
import { emitText } from '../src/core/post/program.js';
import { grbl } from '../src/core/post/grbl.js';

const input = process.argv[2];
const output = process.argv[3] ?? 'out.nc';

if (input === undefined) {
	console.error('usage: node lab/gcode.mjs <in.svg> [out.nc]');
	process.exit(1);
}

const TOOL = { number: 1, diameter: 3.175, rpm: 12000 };
const FEEDS = { cut: 900, plunge: 300 };
const THICKNESS = 4;
const CUT_DEPTH = 5;
const PASS_DEPTH = 1;
const SAFE_Z = 5;
const TABS = [0.15, 0.4, 0.62, 0.85].map((position) => ({ position, length: 8, depth: 3 }));

const { shapes, viewport } = importSvgDocument(fs.readFileSync(input, 'utf8'), {
	pixelsPerInch: Number(process.env.DPI ?? 96),
});

const passes = computeDepthPasses(CUT_DEPTH, PASS_DEPTH);
const jobs = [];
const notes = [];

for (const shape of shapes) {
	for (const sub of shape.subPaths) {

		if (sub.closed !== false)
			continue;

		const source = flattenSubPath(sub, { tolerance: 0.02 }).points;
		const { path: toolpath, warnings: offsetWarnings } =
			offsetAlongNormals(source, TOOL.diameter / 2, { side: Side.LEFT });

		if (toolpath.length < 2)
			continue;

		const { spans, warnings: tabWarnings } =
			placeTabs(source, toolpath, TABS, { toolRadius: TOOL.diameter / 2 });

		notes.push(...offsetWarnings, ...tabWarnings);

		jobs.push({
			name: `${shape.label} — left offset`,
			tool: TOOL,
			feeds: FEEDS,
			passes: passes.map((z) => ({ z, runs: planPass(toolpath, spans, z) })),
		});
	}
}

const { text, warnings, stats } = emitText(
	{ safeZ: SAFE_Z, jobs, program: { name: path.basename(input) } },
	{ dialect: grbl({ units: 'mm', decimals: 3 }) },
);

fs.writeFileSync(output, text);

const lines = text.split('\n').length;
console.log(`${input} -> ${output}`);
console.log(`  document ${viewport.physical.width.toFixed(1)} x ${viewport.physical.height.toFixed(1)} mm`);
console.log(`  ${jobs.length} jobs, ${passes.length} passes each, ${THICKNESS}mm stock cut ${CUT_DEPTH}mm`);
console.log(`  ${lines} lines, ${stats.rapids} rapids, ${stats.cuts} cuts, ${stats.plunges} plunges`);
console.log(`  ${(text.length / 1024).toFixed(1)} KiB`);
for (const note of [...new Set([...notes, ...warnings])])
	console.log(`  ! ${note}`);
