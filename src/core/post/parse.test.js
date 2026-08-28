import { describe, it, expect } from 'vitest';
import { parseGCode, flattenMoves, readWords } from './parse.js';
import { emitText } from './program.js';
import { grbl } from './grbl.js';

const at = (move, key) => [move[key].x, move[key].y, move[key].z];


describe('reading words', () => {

	it('drops both comment forms, including one mid-line', () => {
		expect(readWords('G1 X10 ; go right').map((w) => w.letter)).toEqual(['G', 'X']);
		expect(readWords('G1 (rapid over) X10 Y2').map((w) => w.letter)).toEqual(['G', 'X', 'Y']);
	});

	it('copes with spacing and lower case', () => {
		expect(readWords('g1x10.5y-2')).toEqual([
			{ letter: 'G', value: 1 },
			{ letter: 'X', value: 10.5 },
			{ letter: 'Y', value: -2 },
		]);
	});
});


describe('the bugs inherited from NCviewer, fixed', () => {

	it('keeps a full circle instead of dropping it', () => {
		// coincident endpoints with IJK is exactly how a full circle is written,
		// and a zero sweep is exactly the wrong reading of it
		const { moves, stats } = parseGCode('G21 G90 G17\nG0 X10 Y0\nG2 X10 Y0 I-10 J0\n');
		const arc = moves.find((m) => m.kind === 'arc');
		expect(arc).toBeDefined();
		expect(stats.fullCircles).toBe(1);
		expect(Math.abs(arc.sweep)).toBeCloseTo(2 * Math.PI, 9);
		expect(arc.radius).toBeCloseTo(10, 9);
	});

	it('pairs I/J/K with the right axes in G18 and G19', () => {
		// a quarter circle in ZX. Pairing the offsets with the wrong axes puts
		// the centre somewhere else entirely
		const { moves } = parseGCode('G21 G90 G18\nG0 X10 Y0 Z0\nG2 X0 Y0 Z10 I-10 K0\n');
		const arc = moves.find((m) => m.kind === 'arc');
		expect(arc.centre.x).toBeCloseTo(0, 9);
		expect(arc.centre.z).toBeCloseTo(0, 9);
		expect(arc.radius).toBeCloseTo(10, 9);
	});

	it('honours the sign of R, which asks for the long way round', () => {
		const short = parseGCode('G21 G90 G17\nG0 X0 Y0\nG2 X10 Y0 R10\n').moves.at(-1);
		const long = parseGCode('G21 G90 G17\nG0 X0 Y0\nG2 X10 Y0 R-10\n').moves.at(-1);

		expect(Math.abs(short.sweep)).toBeLessThan(Math.PI);
		expect(Math.abs(long.sweep)).toBeGreaterThan(Math.PI);
	});

	it('emits no move for a line that commands none', () => {
		const { moves } = parseGCode('G21\nG90\nG17\nG94\nM3 S1000\nG4 P2\n');
		expect(moves).toEqual([]);
	});

	it('reads G20 as inches rather than silently shrinking the job 25.4x', () => {
		const { moves } = parseGCode('G20 G90\nG0 X1 Y0\nG1 X2 Y0\n');
		expect(at(moves.at(-1), 'to')[0]).toBeCloseTo(50.8, 9);
	});
});


describe('modal state', () => {

	it('carries the motion mode across lines with only coordinates', () => {
		const { moves } = parseGCode('G21 G90\nG1 X10 F500\nX20\nX30\n');
		expect(moves).toHaveLength(3);
		expect(moves.every((m) => m.kind === 'feed')).toBe(true);
		expect(moves.every((m) => m.feed === 500)).toBe(true);
	});

	it('separates rapids from feeds', () => {
		const { stats } = parseGCode('G21 G90\nG0 X10\nG1 X20 F300\nG0 X30\n');
		expect(stats.rapids).toBe(2);
		expect(stats.feeds).toBe(1);
	});

	it('handles incremental mode', () => {
		const { moves } = parseGCode('G21 G91\nG1 X10 F100\nX10\n');
		expect(at(moves.at(-1), 'to')[0]).toBeCloseTo(20, 9);
	});

	it('tracks the spindle and the tool', () => {
		const { moves } = parseGCode('G21 G90\nT2 M3 S9000\nG1 X5 F100\nM5\nG1 X10\n');
		expect(moves[0].spindle).toBe(9000);
		expect(moves[0].tool).toBe(2);
		expect(moves[1].spindle).toBe(0);
	});

	it('drops a move that goes nowhere', () => {
		const { moves } = parseGCode('G21 G90\nG1 X10 F100\nX10\nY0\n');
		expect(moves).toHaveLength(1);
	});
});


describe('round trip: what we emit is what a reader sees', () => {

	// The whole reason this module exists. Independent of the emitter by
	// construction — it shares no constants, formatting or geometry with it.

	const quarter = (radius = 25, steps = 400) => {
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
			name: 'Round trip', tool: { number: 1, rpm: 12000 },
			feeds: { cut: 900, plunge: 300 }, passes: [{ z: -2, runs }],
		}],
	});

	/** Furthest any traced point strays from the path that was planned. */
	const strayFrom = (points, reference) => {
		let worst = 0;
		for (const [px, py] of points) {
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

	it('traces the planned toolpath, arcs and all', () => {
		const source = quarter();
		const { text } = emitText(planFor([source]), { arcTolerance: 0.01 });
		const { moves, warnings } = parseGCode(text);

		expect(warnings).toEqual([]);

		const cutting = flattenMoves(moves.filter((m) => m.kind !== 'rapid'), { tolerance: 0.001 })
			.flatMap((m) => m.points)
			.filter(([, , z]) => z < 0)
			.map(([x, y]) => [x, y]);

		expect(strayFrom(cutting, source)).toBeLessThanOrEqual(0.01 + 1e-6);
	});

	it('survives the trip in inches', () => {
		const source = quarter();
		const { text } = emitText(planFor([source]),
			{ dialect: grbl({ units: 'inch', decimals: 5 }), arcTolerance: 0.01 });
		const { moves } = parseGCode(text);

		const cutting = flattenMoves(moves.filter((m) => m.kind !== 'rapid'), { tolerance: 0.001 })
			.flatMap((m) => m.points)
			.filter(([, , z]) => z < 0)
			.map(([x, y]) => [x, y]);

		expect(strayFrom(cutting, source)).toBeLessThanOrEqual(0.02);
	});

	it('sees the same number of arcs the emitter reported writing', () => {
		const { text, stats } = emitText(planFor([quarter()]), { arcTolerance: 0.01 });
		expect(parseGCode(text).stats.arcs).toBe(stats.arcs);
	});
});
