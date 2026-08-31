import { describe, it, expect } from 'vitest';
import { emitProgram, emitText } from './program.js';
import { grbl, formatNumber } from './grbl.js';

/**
 * A deliberately small, independent G-code reader.
 *
 * Written against the emitted TEXT rather than sharing anything with the
 * emitter, so a bug in the emitter cannot hide behind a matching bug here. It
 * models exactly what a controller does: track modal state, apply the words on
 * each line, record the resulting move.
 */
const read = (text) => {
	const moves = [];
	let at = { x: NaN, y: NaN, z: NaN };
	let mode = null;
	let feed = null;
	let units = 'mm';
	let spindle = 0;

	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line === '' || line.startsWith(';'))
			continue;

		const words = line.match(/[A-Z]-?[0-9.]*/g) ?? [];
		const word = (letter) => {
			const found = words.find((w) => w[0] === letter);
			return found === undefined ? undefined : Number(found.slice(1));
		};

		for (const w of words) {
			if (w === 'G20') units = 'inch';
			if (w === 'G21') units = 'mm';
			if (w === 'G0' || w === 'G1') mode = w;
			if (w[0] === 'M' && w.slice(1) === '3') spindle = word('S') ?? spindle;
			if (w === 'M5') spindle = 0;
		}

		if (word('F') !== undefined)
			feed = word('F');

		const scale = units === 'inch' ? 25.4 : 1;
		const to = {
			x: word('X') === undefined ? at.x : word('X') * scale,
			y: word('Y') === undefined ? at.y : word('Y') * scale,
			z: word('Z') === undefined ? at.z : word('Z') * scale,
		};

		// Bound to THIS move's endpoints, not to the loop variable, which by the
		// time a test reads it holds the final position of the program.
		const from = at;
		const shifted = (axis) => Number.isFinite(from[axis]) && to[axis] !== from[axis];

		// A move from an unknown position is still a move the machine makes; we
		// just cannot say how far. Recorded, and flagged, so tests measuring
		// distance can leave it out without losing it from the sequence.
		const establishes = ['x', 'y', 'z'].some((a) =>
			!Number.isFinite(from[a]) && Number.isFinite(to[a]));
		const moved = shifted('x') || shifted('y') || shifted('z') || establishes;

		if (moved && (mode === 'G0' || mode === 'G1'))
			moves.push({ rapid: mode === 'G0', from, to, feed, spindle, shifted, establishes });

		at = to;
	}

	return moves;
};

const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];

const onePass = (runs = [square], overrides = {}) => ({
	safeZ: 5,
	jobs: [{
		name: 'Outline',
		tool: { number: 1, diameter: 3.175, rpm: 12000 },
		feeds: { cut: 900, plunge: 300 },
		passes: [{ z: -2, runs }],
		...overrides,
	}],
});


describe('the machine state the program establishes', () => {

	it('sets units, absolute mode and the XY plane before anything moves', () => {
		const { lines } = emitProgram(onePass());
		// note the space: G17 also begins "G1"
		const firstMove = lines.findIndex((l) => /^G[01] /.test(l));
		const preamble = lines.slice(0, firstMove);
		for (const code of ['G21', 'G90', 'G17'])
			expect(preamble, code).toContain(code);
	});

	it('starts the spindle and lets it spin up before the first cut', () => {
		const { lines } = emitProgram(onePass());
		const spindle = lines.findIndex((l) => l.startsWith('M3'));
		const firstCut = lines.findIndex((l) => /^G1 /.test(l));
		expect(spindle).toBeGreaterThan(-1);
		expect(spindle).toBeLessThan(firstCut);
		expect(lines[spindle + 1]).toMatch(/^G4 P/);
		expect(lines[spindle]).toBe('M3 S12000');
	});

	it('stops the spindle and ends the program', () => {
		const { lines } = emitProgram(onePass());
		expect(lines.slice(-2)).toEqual(['M5', 'M2']);
	});
});


describe('rapids are G0 — the jscut bug', () => {

	// jscut emits G1 at a high feed for every rapid. That gives up the
	// controller's rapid handling and makes a positioning move
	// indistinguishable from a cutting move to anything reading the file.

	it('positions with G0 and cuts with G1', () => {
		const moves = read(emitText(onePass()).text);
		const rapids = moves.filter((m) => m.rapid);
		const cuts = moves.filter((m) => !m.rapid);
		expect(rapids.length).toBeGreaterThan(0);
		expect(cuts.length).toBeGreaterThan(0);
	});

	it('gives every rapid no feed word of its own', () => {
		const { lines } = emitProgram(onePass());
		for (const line of lines.filter((l) => /^G0 /.test(l)))
			expect(line, line).not.toMatch(/F/);
	});
});


describe('never travels across the work at cutting depth', () => {

	// The invariant that makes a tab a break rather than a gouge.

	it('holds it across several runs and passes', () => {
		const plan = {
			safeZ: 5,
			jobs: [{
				name: 'Broken by tabs',
				tool: { number: 1, rpm: 10000 },
				feeds: { cut: 800, plunge: 250 },
				passes: [
					{ z: -1, runs: [square] },
					{ z: -2, runs: [[[0, 0], [4, 0]], [[6, 0], [10, 0]], [[10, 2], [10, 10]]] },
				],
			}],
		};

		for (const move of read(emitText(plan).text)) {
			const inPlane = move.shifted('x') || move.shifted('y');
			if (move.rapid && inPlane) {
				expect(move.from.z, `rapid from Z${move.from.z}`).toBeGreaterThanOrEqual(5);
				expect(move.to.z, `rapid to Z${move.to.z}`).toBeGreaterThanOrEqual(5);
			}
		}
	});

	it('throws rather than emitting a plan that would require it', () => {
		// a plan claiming a safe Z below the cut is a bug upstream, not something
		// to quietly emit
		expect(() => emitProgram({
			safeZ: -10,
			jobs: [{
				name: 'bad', tool: { number: 1, rpm: 1000 }, feeds: { cut: 500 },
				passes: [{ z: -2, runs: [square, square] }],
			}],
		})).toThrow(/not above a pass/);
	});

	it('plunges only after arriving above the start of the run', () => {
		const moves = read(emitText(onePass()).text);
		const plunge = moves.findIndex((m) => !m.rapid && m.to.z < 0);
		expect(plunge).toBeGreaterThan(0);
		const before = moves[plunge - 1];
		expect(before.rapid).toBe(true);
		expect(before.to.x).toBeCloseTo(square[0][0], 6);
		expect(before.to.y).toBeCloseTo(square[0][1], 6);
	});
});


describe('the cut it emits is the cut it was given', () => {

	it('reproduces every point of every run, in order', () => {
		const runs = [
			[[0, 0], [10, 0], [10, 10]],
			[[20, 5], [25, 5], [25, 12.5], [20, 12.5]],
		];
		const moves = read(emitText(onePass(runs)).text);

		// the XY cutting moves, in order, ignoring plunges
		const cut = moves
			.filter((m) => !m.rapid && (m.to.x !== m.from.x || m.to.y !== m.from.y))
			.map((m) => [m.to.x, m.to.y]);

		expect(cut).toEqual(runs.flatMap((run) => run.slice(1)));
	});

	it('holds the cut at the pass depth throughout', () => {
		const moves = read(emitText(onePass()).text);
		for (const move of moves.filter((m) => !m.rapid && m.to.x !== m.from.x))
			expect(move.to.z).toBeCloseTo(-2, 6);
	});

	it('uses the plunge feed going down and the cut feed along', () => {
		const moves = read(emitText(onePass()).text);
		const plunge = moves.find((m) => !m.rapid && m.to.z < m.from.z);
		const along = moves.find((m) => !m.rapid && m.to.x !== m.from.x);
		expect(plunge.feed).toBe(300);
		expect(along.feed).toBe(900);
	});

	it('does not repeat the feed word once it is set', () => {
		const { lines } = emitProgram(onePass());
		const feeds = lines.filter((l) => /F[0-9]/.test(l));
		// one for the plunge, one for the cut, and nothing more
		expect(feeds.length).toBe(2);
	});

	it('emits no zero-length moves', () => {
		const runs = [[[0, 0], [0, 0], [10, 0], [10, 0], [10, 10]]];
		for (const move of read(emitText(onePass(runs)).text).filter((m) => !m.establishes)) {
			const distance = ['x', 'y', 'z']
				.reduce((sum, axis) => sum + (move.shifted(axis)
					? Math.abs(move.to[axis] - move.from[axis]) : 0), 0);
			expect(distance, JSON.stringify({ from: move.from, to: move.to }))
				.toBeGreaterThan(0);
		}
	});
});


describe('inches', () => {

	it('converts and says G20', () => {
		const plan = onePass([[[0, 0], [25.4, 0]]]);
		const { text } = emitText(plan, { dialect: grbl({ units: 'inch', decimals: 4 }) });
		expect(text).toMatch(/^G20$/m);
		expect(text).toMatch(/X1(\s|$)/m);
		// and reading it back in inches gives the millimetres we started with
		const moves = read(text);
		const last = moves[moves.length - 1];
		expect(last.to.x).toBeCloseTo(25.4, 6);
	});
});


describe('number formatting', () => {

	it('trims trailing zeros', () => {
		expect(formatNumber(10, 3)).toBe('10');
		expect(formatNumber(10.5, 3)).toBe('10.5');
		expect(formatNumber(10.123456, 3)).toBe('10.123');
	});

	it('never emits negative zero, which is legal and alarming', () => {
		expect(formatNumber(-0.0001, 3)).toBe('0');
		expect(formatNumber(-0, 3)).toBe('0');
	});

	it('refuses a non-finite coordinate rather than emitting XNaN', () => {
		// jscut's dead tab path emits `G1 XNaN YNaN`
		expect(() => formatNumber(NaN, 3)).toThrow(RangeError);
		expect(() => formatNumber(Infinity, 3)).toThrow(RangeError);
	});

	it('honours the decimal setting rather than hard-coding four', () => {
		const plan = onePass([[[0, 0], [1.23456789, 0]]]);
		expect(emitText(plan, { dialect: grbl({ decimals: 2 }) }).text).toMatch(/X1\.23/);
		expect(emitText(plan, { dialect: grbl({ decimals: 5 }) }).text).toMatch(/X1\.23457/);
	});
});


describe('job breadcrumbs and tool changes', () => {

	const twoJobs = {
		safeZ: 5,
		jobs: [
			{
				name: 'Rough', tool: { number: 1, diameter: 6, rpm: 10000 },
				feeds: { cut: 900, plunge: 300 }, passes: [{ z: -1, runs: [square] }],
			},
			{
				name: 'Finish', tool: { number: 2, diameter: 3.175, rpm: 14000 },
				feeds: { cut: 600, plunge: 200 }, passes: [{ z: -2, runs: [square] }],
			},
		],
	};

	it('wraps each job in balanced, named comments', () => {
		const { lines } = emitProgram(twoJobs);
		const opens = lines.filter((l) => l.startsWith(';<job'));
		const closes = lines.filter((l) => l === ';</job>');
		expect(opens).toEqual([';<job name="Rough">', ';<job name="Finish">']);
		expect(closes).toHaveLength(2);
	});

	it('stops the spindle, retracts and pauses before a tool change', () => {
		const { lines, stats } = emitProgram(twoJobs);
		const pause = lines.indexOf('M0');
		expect(pause).toBeGreaterThan(-1);
		expect(stats.toolChanges).toBe(1);

		const before = lines.slice(0, pause);
		expect(before[before.length - 3]).toBe('M5');
		expect(before[before.length - 2]).toBe('G0 Z5');
		expect(before[before.length - 1]).toMatch(/change to tool 2/);
		expect(lines[pause + 1]).toBe('M3 S14000');
	});

	it('does not restart the spindle between jobs sharing a tool and speed', () => {
		const same = {
			safeZ: 5,
			jobs: [1, 2].map((i) => ({
				name: `job ${i}`, tool: { number: 1, rpm: 12000 },
				feeds: { cut: 900, plunge: 300 }, passes: [{ z: -i, runs: [square] }],
			})),
		};
		expect(emitProgram(same).lines.filter((l) => l.startsWith('M3'))).toHaveLength(1);
	});

	it('strips characters that would break the comment out of a job name', () => {
		const nasty = { ...twoJobs, jobs: [{ ...twoJobs.jobs[0], name: 'a"b<c>d\ne' }] };
		expect(emitProgram(nasty).lines).toContain(';<job name="abcde">');
	});
});


describe('refusing to emit nonsense', () => {

	it('rejects a job with no cutting feed', () => {
		expect(() => emitProgram({
			safeZ: 5,
			jobs: [{ name: 'x', tool: { number: 1, rpm: 1 }, feeds: {}, passes: [] }],
		})).toThrow(RangeError);
	});

	it('rejects a non-finite safe Z', () => {
		expect(() => emitProgram({ safeZ: NaN, jobs: [] })).toThrow(RangeError);
	});

	it('reports a run too short to cut rather than emitting a bare plunge', () => {
		const { warnings, stats } = emitProgram(onePass([[[1, 1]], square]));
		expect(warnings.join(' ')).toMatch(/1 point/);
		expect(stats.plunges).toBe(1);
	});
});


/**
 * Traces the physical path an emitted program describes, arcs included.
 *
 * A second reader, again sharing nothing with the emitter. It interpolates G2
 * and G3 the way a controller does — centre from incremental I and J, sweep the
 * short way in the commanded direction — so the result is the shape the machine
 * would actually move through, not the shape we hoped we asked for.
 */
const trace = (text, perArc = 64) => {
	const path = [];
	let at = { x: NaN, y: NaN, z: NaN };
	let mode = null;

	for (const raw of text.split('\n')) {
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

		const to = {
			x: word('X') ?? at.x,
			y: word('Y') ?? at.y,
			z: word('Z') ?? at.z,
		};

		if ((mode === 'G2' || mode === 'G3') && Number.isFinite(at.x)) {

			const cx = at.x + (word('I') ?? 0);
			const cy = at.y + (word('J') ?? 0);
			const radius = Math.hypot(at.x - cx, at.y - cy);
			const from = Math.atan2(at.y - cy, at.x - cx);
			const until = Math.atan2(to.y - cy, to.x - cx);

			let sweep = until - from;
			if (mode === 'G2') {
				while (sweep > 0) sweep -= 2 * Math.PI;
				while (sweep < -2 * Math.PI) sweep += 2 * Math.PI;
			} else {
				while (sweep < 0) sweep += 2 * Math.PI;
				while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
			}

			for (let k = 1; k <= perArc; k++) {
				const a = from + (sweep * (k / perArc));
				path.push([cx + (radius * Math.cos(a)), cy + (radius * Math.sin(a))]);
			}

		} else if (mode === 'G1' && Number.isFinite(at.x)
			&& (to.x !== at.x || to.y !== at.y)) {
			path.push([to.x, to.y]);
		}

		at = to;
	}

	return path;
};

/** Furthest any point of one path strays from the other. */
const strayFrom = (path, reference) => {
	let worst = 0;
	for (const [px, py] of path) {
		let near = Infinity;
		for (let i = 0; i + 1 < reference.length; i++) {
			const [ax, ay] = reference[i];
			const [bx, by] = reference[i + 1];
			const vx = bx - ax, vy = by - ay;
			const lengthSquared = (vx * vx) + (vy * vy);
			let t = lengthSquared === 0 ? 0 : (((px - ax) * vx) + ((py - ay) * vy)) / lengthSquared;
			t = Math.max(0, Math.min(1, t));
			near = Math.min(near, Math.hypot(px - (ax + (t * vx)), py - (ay + (t * vy))));
		}
		worst = Math.max(worst, near);
	}
	return worst;
};


describe('arcs', () => {

	/** A quarter circle sampled the way an offset leaves one. */
	const quarter = (radius = 30, steps = 300) => {
		const pts = [];
		for (let i = 0; i <= steps; i++) {
			const a = (Math.PI / 2) * (i / steps);
			pts.push([radius * Math.cos(a), radius * Math.sin(a)]);
		}
		return pts;
	};

	const planFor = (runs) => ({
		safeZ: 5,
		jobs: [{
			name: 'Arcs', tool: { number: 1, rpm: 12000 },
			feeds: { cut: 900, plunge: 300 }, passes: [{ z: -2, runs }],
		}],
	});

	it('emits straight moves only when no arc tolerance is given', () => {
		const { text } = emitText(planFor([quarter()]));
		expect(text).not.toMatch(/^G[23] /m);
	});

	it('emits G2 or G3 with incremental I and J once it is', () => {
		const { text, stats } = emitText(planFor([quarter()]), { arcTolerance: 0.01 });
		expect(stats.arcs).toBeGreaterThan(0);
		expect(text).toMatch(/^G[23] X[-0-9.]+ Y[-0-9.]+ I[-0-9.]+ J[-0-9.]+/m);
	});

	it('MOVES WHERE IT SHOULD — the path a controller would trace matches', () => {
		// The check the fitting cannot do for itself. Read the emitted arcs back
		// the way a controller would, sweep them, and compare the resulting
		// motion against the toolpath that was asked for.
		const source = quarter();
		const { text } = emitText(planFor([source]), { arcTolerance: 0.01 });

		expect(strayFrom(trace(text), source)).toBeLessThanOrEqual(0.01 + 1e-6);
	});

	it('holds that on a wave, both directions of curvature', () => {
		const source = [];
		for (let x = 0; x <= 200; x += 0.2)
			source.push([x, 9 * Math.sin((2 * Math.PI * x) / 40)]);

		const { text, stats } = emitText(planFor([source]), { arcTolerance: 0.02 });

		expect(stats.arcs).toBeGreaterThan(4);
		expect(strayFrom(trace(text), source)).toBeLessThanOrEqual(0.02 + 1e-6);
	});

	it('cuts the block count by an order of magnitude', () => {
		const source = quarter(30, 2000);
		const straight = emitText(planFor([source])).stats;
		const fitted = emitText(planFor([source]), { arcTolerance: 0.01 }).stats;

		expect(straight.cuts).toBeGreaterThan(1900);
		expect(fitted.cuts + fitted.arcs).toBeLessThan(straight.cuts / 100);
	});

	it('tightening the tolerance keeps the promise', () => {
		const source = quarter();
		for (const tolerance of [0.002, 0.01, 0.05]) {
			const { text } = emitText(planFor([source]), { arcTolerance: tolerance });
			expect(strayFrom(trace(text), source), `${tolerance}`)
				.toBeLessThanOrEqual(tolerance + 1e-6);
		}
	});
});


describe('ramping in rather than plunging', () => {

	const line = [[0, 0], [200, 0]];
	const planFor = () => ({
		safeZ: 5,
		jobs: [{
			name: 'Ramped', tool: { number: 1, rpm: 12000 },
			feeds: { cut: 900, plunge: 300 },
			passes: [{ z: -1, runs: [line] }, { z: -2, runs: [line] }],
		}],
	});

	it('plunges straight down when no ramp is asked for', () => {
		const { stats } = emitProgram(planFor());
		expect(stats.plunges).toBe(2);
		expect(stats.ramps).toBe(0);
	});

	it('replaces every plunge with a ramp when one is', () => {
		const { stats } = emitProgram(planFor(), { ramp: { angleRadians: 3 * Math.PI / 180 } });
		expect(stats.plunges).toBe(0);
		expect(stats.ramps).toBe(2);
	});

	it('never moves straight down in X-Y once ramping', () => {
		// the whole point: no vertical entry into material anywhere
		const { text } = emitText(planFor(), { ramp: { angleRadians: 3 * Math.PI / 180 } });
		for (const move of read(text)) {
			if (move.rapid || move.establishes)
				continue;
			const descends = move.to.z < move.from.z;
			const travels = move.shifted('x') || move.shifted('y');
			expect(descends && !travels, JSON.stringify({ from: move.from, to: move.to })).toBe(false);
		}
	});

	it('arrives at the start of the cut at full depth, so nothing is left shallow', () => {
		const { text } = emitText(planFor(), { ramp: { angleRadians: 3 * Math.PI / 180 } });
		const moves = read(text).filter((m) => !m.rapid && !m.establishes);

		// the first pass ends its ramp back at X0 at Z-1
		const arrival = moves.find((m) => Math.abs(m.to.z + 1) < 1e-9 && Math.abs(m.to.x) < 1e-6);
		expect(arrival).toBeDefined();
	});

	it('starts a ramp from ITS OWN pass above, not from another job’s', () => {

		// Two jobs stepping down by different amounts interleave: 2, 2.5, 4, 5.
		// Reading every job's passes made the second job's FIRST pass rapid down
		// to Z-2 -- a depth only the first job had ever cut, and only where the
		// first job cut it. The program RAPIDS to this height, so getting it
		// wrong is the cutter arriving inside the work at traverse speed.
		const plan = {
			safeZ: 5,
			jobs: [
				{
					name: 'Coarse', tool: { number: 1, rpm: 12000 }, feeds: { cut: 900, plunge: 300 },
					passes: [{ z: -2, runs: [line] }, { z: -4, runs: [line] }],
				},
				{
					name: 'Fine', tool: { number: 1, rpm: 12000 }, feeds: { cut: 900, plunge: 300 },
					passes: [{ z: -2.5, runs: [line] }, { z: -5, runs: [line] }],
				},
			],
		};

		const { text } = emitText(plan, { ramp: { angleRadians: 3 * Math.PI / 180 } });
		const lines = text.split('\n');
		const from = lines.indexOf(';<job name="Fine">');
		const rapids = lines.slice(from, lines.indexOf(';</job>', from))
			.filter((l) => /^G0 Z/.test(l))
			.map((l) => Number(l.slice(4)));

		// down to the surface for the first pass, down to its own -2.5 for the
		// second, and up to safe Z in between
		expect(rapids).toEqual([5, 0, 5, -2.5]);
	});

	it('only descends from the pass above, not from safe Z', () => {
		// ramping the full way from safe Z would spend most of the ramp in air
		const { text } = emitText(planFor(), { ramp: { angleRadians: 3 * Math.PI / 180 } });
		const moves = read(text).filter((m) => !m.rapid && !m.establishes);
		const deepest = moves.filter((m) => m.to.z < -1);
		for (const move of deepest)
			expect(move.from.z).toBeLessThanOrEqual(0 + 1e-9);
	});

	it('reports a path too short to ramp gently rather than silently steepening', () => {
		const stub = { ...planFor() };
		stub.jobs = [{ ...stub.jobs[0], passes: [{ z: -5, runs: [[[0, 0], [2, 0]]] }] }];
		const { warnings } = emitProgram(stub, { ramp: { angleRadians: 3 * Math.PI / 180 } });
		expect(warnings.join(' ')).toMatch(/ramp/);
	});
});
