/**
 * @file simulate.mjs
 * @description Draws a G-code file the way a controller would run it.
 *
 * Usage: node lab/simulate.mjs <in.nc> [out.html]
 *
 * Nothing here knows how the file was made. It reads the text with
 * `core/post/parse.js`, interpolates the arcs, and draws the result — so what
 * appears is the motion the machine would make, not the motion we intended.
 *
 * That distinction has already paid for itself once: arc fitting passed every
 * unit test on synthetic curves and then bulged 5.15mm off a right-angled corner
 * on real artwork. Greg: *"once we have it actually working and simulating if
 * there's any weirdness with the arcs it will reveal itself."*
 *
 * Arcs are drawn in their own colour, so an arc that has gone somewhere it
 * should not is visible as a coloured bulge rather than hidden in a mass of
 * identical green lines.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseGCode, flattenMoves } from '../src/core/post/parse.js';

const input = process.argv[2];
const output = process.argv[3] ?? 'simulate.html';

if (input === undefined) {
	console.error('usage: node lab/simulate.mjs <in.nc> [out.html]');
	process.exit(1);
}

const FEED = '#7ee081';
const ARC = '#c792ea';
const RAPID = '#e0798f';
const PLUNGE = '#e8b64c';

const text = fs.readFileSync(input, 'utf8');
const { moves, warnings, stats } = parseGCode(text);
const flat = flattenMoves(moves, { tolerance: 0.005 });

const drawn = flat
	.map((move, i) => ({ ...move, z: moves[i].to.z, from: moves[i].from, to: moves[i].to }))
	.filter((move) => move.points.length > 1);

const all = drawn.flatMap((m) => m.points);
const box = {
	minX: Math.min(...all.map((p) => p[0])), maxX: Math.max(...all.map((p) => p[0])),
	minY: Math.min(...all.map((p) => p[1])), maxY: Math.max(...all.map((p) => p[1])),
};

const pad = 6;
const view = [box.minX - pad, box.minY - pad,
	(box.maxX - box.minX) + (pad * 2), (box.maxY - box.minY) + (pad * 2)];
const hair = Math.max(view[2], view[3]) / 1400;

const d = (points) => 'M' + points.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join('L');

/**
 * One layer of the drawing, so cuts sit on top of rapids.
 *
 * @param {Function} pick - which moves belong to this layer
 * @param {String} colour - stroke colour
 * @param {Number} width - stroke width in hairlines
 * @param {Boolean} [dash] - draw dashed
 * @returns {String} SVG paths
 */
const layer = (pick, colour, width, dash) => drawn.filter(pick).map((move) =>
	`<path d="${d(move.points)}" fill="none" stroke="${colour}" stroke-width="${hair * width}"`
	+ (dash ? ` stroke-dasharray="${hair * 5} ${hair * 4}"` : '')
	+ ' stroke-linecap="round" stroke-linejoin="round"/>').join('');

// a plunge is a feed move that only changes Z
const isPlunge = (m) => m.kind === 'feed' && m.from.x === m.to.x && m.from.y === m.to.y;

const body = layer((m) => m.kind === 'rapid', RAPID, 1.1, true)
	+ layer((m) => m.kind === 'feed' && !isPlunge(m), FEED, 2.2)
	+ layer((m) => m.kind === 'arc', ARC, 2.2)
	+ drawn.filter(isPlunge).map((m) =>
		`<circle cx="${m.to.x.toFixed(2)}" cy="${m.to.y.toFixed(2)}" r="${hair * 4}"`
		+ ` fill="none" stroke="${PLUNGE}" stroke-width="${hair * 1.4}"/>`).join('');

const depths = [...new Set(moves.filter((m) => m.kind !== 'rapid').map((m) => m.to.z))]
	.sort((a, b) => b - a);

fs.writeFileSync(output, `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Simulated — ${path.basename(input)}</title><style>
 :root{color-scheme:dark}
 body{margin:0;padding:26px;background:#0f0f12;color:#d7d7de;font:13px/1.6 ui-monospace,Menlo,Consolas,monospace}
 h1{font-size:15px;margin:0 0 4px;color:#fff}
 .lead{color:#8a8a95;margin:0 0 6px;max-width:90ch}
 .key{color:#8a8a95;margin:0 0 14px}
 figure{margin:0;background:#16161a;border:1px solid #2a2a33;border-radius:6px;padding:11px}
 svg{width:100%;height:auto;display:block}
 .warn{color:#e0798f}
 b.feed{color:#7ee081}b.arc{color:#c792ea}b.rapid{color:#e0798f}b.plunge{color:#e8b64c}
</style></head><body>
<h1>Simulated — ${path.basename(input)}</h1>
<p class="lead">Read back from the file and interpolated, so this is the motion the machine
would make rather than the motion we meant. ${stats.lines} commanded lines →
${stats.rapids} rapids, ${stats.feeds} straight cuts, ${stats.arcs} arcs${stats.fullCircles
	? ` (${stats.fullCircles} full circles)` : ''}. Depths: ${depths.map((z) => `${z}`).join(', ')} mm.</p>
<p class="key"><b class="feed">green</b> cutting · <b class="arc">violet</b> arcs ·
<b class="rapid">dashed pink</b> rapids · <b class="plunge">amber</b> plunges.
Arcs are coloured separately on purpose: one that has gone somewhere it should not shows up
as a violet bulge rather than hiding among the straight moves.</p>
${warnings.length ? `<p class="warn">${warnings.join('<br>')}</p>` : ''}
<figure><svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.join(' ')}">
<g transform="translate(0 ${(view[1] * 2) + view[3]}) scale(1 -1)">${body}</g></svg></figure>
</body></html>`);

console.log(`${input} -> ${output}`);
console.log(`  ${stats.lines} lines, ${stats.rapids} rapids, ${stats.feeds} cuts, ${stats.arcs} arcs`);
for (const warning of warnings.slice(0, 5))
	console.log(`  ! ${warning}`);
