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
 *
 * It ends by reading its own output back and tracing the motion a controller
 * would make, arcs interpolated, then measuring that against the toolpath it
 * meant to cut. Arc fitting in particular is the sort of thing that passes every
 * unit test on synthetic curves and then finds something on real artwork.
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
const ARC_TOLERANCE = Number(process.env.ARCTOL ?? 0.01);
const RAMP_ANGLE = (3 * Math.PI) / 180;
// No tabs by default. Greg on the skyline: "In reality, for the skyline both
// parts of the material (upper and lower) will be clamped down, and the pass
// will go completely through with zero tabs." Tabs are hand-placed on the Job in
// the UI, so a lab default that scatters them by fraction of arc length is not
// how anybody would ever place them (D17). TABS=1 to see the broken case.
const TABS = process.env.TABS
	? [0.15, 0.4, 0.62, 0.85].map((position) => ({ position, length: 8, depth: 3 }))
	: [];

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

const plan = { safeZ: SAFE_Z, jobs, program: { name: path.basename(input) } };
const dialect = grbl({ units: 'mm', decimals: Number(process.env.DEC ?? 3) });

const straight = emitText(plan, { dialect });
const { text, warnings, stats } = emitText(plan, {
	dialect,
	arcTolerance: ARC_TOLERANCE,
	ramp: process.env.NORAMP ? undefined : { angleRadians: RAMP_ANGLE },
});

fs.writeFileSync(output, text);

const lines = text.split('\n').length;
console.log(`${input} -> ${output}`);
console.log(`  document ${viewport.physical.width.toFixed(1)} x ${viewport.physical.height.toFixed(1)} mm`);
console.log(`  ${jobs.length} jobs, ${passes.length} passes each, ${THICKNESS}mm stock cut ${CUT_DEPTH}mm`);
console.log(`  ${lines} lines, ${stats.rapids} rapids, ${stats.cuts} straight cuts,`
	+ ` ${stats.arcs} arcs, ${stats.plunges} plunges, ${stats.ramps} ramps`);
console.log(`  ${(text.length / 1024).toFixed(1)} KiB`);
console.log(`  without arc fitting: ${straight.stats.cuts} cuts,`
	+ ` ${(straight.text.length / 1024).toFixed(1)} KiB`
	+ ` — arcs at ${ARC_TOLERANCE}mm cut it to`
	+ ` ${((text.length / straight.text.length) * 100).toFixed(0)}%`);
for (const note of [...new Set([...notes, ...warnings])])
	console.log(`  ! ${note}`);


// ---------------------------------------------------------------- verifying

/**
 * Traces the motion the emitted program describes, arcs interpolated.
 *
 * Deliberately re-derived from the TEXT rather than from anything the emitter
 * knows, so a mistake in the emitter cannot be cancelled out by the same mistake
 * here.
 *
 * @param {String} program - the G-code
 * @param {Number} [perArc=64] - points per arc
 * @returns {Array<Number[]>} the cutting motion, in order
 */
function traceCuts(program, perArc = 64) {

	const motion = [];
	let at = { x: NaN, y: NaN, z: NaN };
	let mode = null;

	for (const raw of program.split('\n')) {

		const line = raw.trim();
		if (line === '' || line.startsWith(';'))
			continue;

		const words = line.match(/[A-Z]-?[0-9.]*/g) ?? [];
		const word = (letter) => {
			const found = words.find((w) => w[0] === letter);
			return found === undefined ? undefined : Number(found.slice(1));
		};

		for (const w of words)
			if (['G0', 'G1', 'G2', 'G3'].includes(w))
				mode = w;

		const to = { x: word('X') ?? at.x, y: word('Y') ?? at.y, z: word('Z') ?? at.z };

		if ((mode === 'G2' || mode === 'G3') && Number.isFinite(at.x)) {

			const cx = at.x + (word('I') ?? 0);
			const cy = at.y + (word('J') ?? 0);
			const radius = Math.hypot(at.x - cx, at.y - cy);
			const from = Math.atan2(at.y - cy, at.x - cx);
			let sweep = Math.atan2(to.y - cy, to.x - cx) - from;

			if (mode === 'G2')
				while (sweep > 0) sweep -= 2 * Math.PI;
			else
				while (sweep < 0) sweep += 2 * Math.PI;

			for (let k = 1; k <= perArc; k++) {
				const a = from + (sweep * (k / perArc));
				motion.push([cx + (radius * Math.cos(a)), cy + (radius * Math.sin(a))]);
			}

		} else if (mode === 'G1' && Number.isFinite(at.x) && (to.x !== at.x || to.y !== at.y)) {
			motion.push([to.x, to.y]);
		}

		at = to;
	}

	return motion;
}

/**
 * Furthest a traced point strays from the nearest planned cut.
 *
 * @param {Array<Number[]>} motion - what the program does
 * @param {Array<Array<Number[]>>} planned - the runs it was meant to cut
 * @returns {Number} the largest deviation, millimetres
 */
function deviation(motion, planned) {

	const cell = 4;
	const grid = new Map();

	for (const run of planned)
		for (let i = 0; i + 1 < run.length; i++) {
			const [a, b] = [run[i], run[i + 1]];
			const minX = Math.floor(Math.min(a[0], b[0]) / cell);
			const maxX = Math.floor(Math.max(a[0], b[0]) / cell);
			const minY = Math.floor(Math.min(a[1], b[1]) / cell);
			const maxY = Math.floor(Math.max(a[1], b[1]) / cell);
			for (let x = minX; x <= maxX; x++)
				for (let y = minY; y <= maxY; y++) {
					const key = `${x},${y}`;
					const bucket = grid.get(key);
					if (bucket === undefined)
						grid.set(key, [[a, b]]);
					else
						bucket.push([a, b]);
				}
		}

	let worst = 0;

	for (const point of motion) {
		let near = Infinity;
		const cx = Math.floor(point[0] / cell);
		const cy = Math.floor(point[1] / cell);
		for (let x = cx - 1; x <= cx + 1; x++)
			for (let y = cy - 1; y <= cy + 1; y++)
				for (const [a, b] of grid.get(`${x},${y}`) ?? []) {
					const vx = b[0] - a[0], vy = b[1] - a[1];
					const lengthSquared = (vx * vx) + (vy * vy);
					let t = lengthSquared === 0
						? 0
						: ((((point[0] - a[0]) * vx) + ((point[1] - a[1]) * vy)) / lengthSquared);
					t = Math.max(0, Math.min(1, t));
					near = Math.min(near,
						Math.hypot(point[0] - (a[0] + (t * vx)), point[1] - (a[1] + (t * vy))));
				}
		worst = Math.max(worst, near);
	}

	return worst;
}

const plannedRuns = jobs.flatMap((job) =>
	job.passes.flatMap((pass) => pass.runs.map((run) => run.points ?? run)));

const strayed = deviation(traceCuts(text), plannedRuns);

console.log(`  verified: read back and traced, worst deviation ${strayed.toFixed(4)}mm`
	+ ` against a ${ARC_TOLERANCE}mm arc tolerance`
	+ `${strayed <= ARC_TOLERANCE + 1e-6 ? '' : '   *** OVER TOLERANCE ***'}`);
