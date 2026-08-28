/**
 * @file parse.js
 * @description Reads G-code back into moves. A test oracle, not part of the
 * pipeline.
 *
 * Nothing in the program needs this to make G-code. It exists so the output can
 * be checked by reading it the way a controller would, and that has already
 * earned its place: arc fitting passed every unit test on synthetic curves and
 * then turned a right-angled corner into a semicircle bulging 5.15mm off the
 * path on real artwork. Tracing the emitted file is what found it.
 *
 * So this file is deliberately independent of the emitter. It shares no
 * constants, no formatting, no geometry. A parser built out of the emitter's
 * own parts would agree with it about a mistake.
 *
 * ## What was taken from NCviewer, and what was fixed
 *
 * The structure of `parseGCode()` (index.html 617–786) is the one genuinely
 * reusable, DOM-free piece in that repository, and its modal state machine is
 * the right shape. Its bugs are not:
 *
 * - **A full circle is silently dropped.** When start and end coincide the
 *   sweep computes as zero and the move vanishes — the one arc where that is
 *   certainly wrong, since IJK with coincident endpoints is precisely how a full
 *   circle is written.
 * - **G18/G19 swap the wrong offsets**, so an arc in the XZ or YZ plane goes
 *   somewhere else entirely.
 * - **The `R` form ignores the sign.** A negative R means the major arc, the
 *   long way round; dropping the sign silently cuts the wrong half.
 * - **Any line containing a G-word emits a move**, so `G21` on its own produces
 *   a zero-length move and every consumer has to filter them out.
 * - **G20/G21 are absent entirely**, so an imperial file is read as millimetres
 *   and comes out 25.4 times too small.
 */

/** Motion modes this understands. */
const MOTION = new Set(['G0', 'G1', 'G2', 'G3']);

/** Millimetres per inch. */
const MM_PER_INCH = 25.4;

/** The three arc planes, and which axes carry the centre offsets. */
const PLANES = Object.freeze({
	G17: { axes: ['x', 'y'], offsets: ['i', 'j'], normal: 'z' },
	G18: { axes: ['z', 'x'], offsets: ['k', 'i'], normal: 'y' },
	G19: { axes: ['y', 'z'], offsets: ['j', 'k'], normal: 'x' },
});


/**
 * Splits one line into its words, dropping comments.
 *
 * Both comment forms: `;` to end of line, and `(...)` inline, which may appear
 * mid-line with code after it.
 *
 * @param {String} line - one line of G-code
 * @returns {Array<Object>} `{ letter, value }` per word
 */
export function readWords(line) {

	const withoutComments = line
		.replace(/\([^)]*\)/g, ' ')
		.replace(/;.*$/, '');

	const words = [];
	const pattern = /([A-Za-z])\s*([-+]?[0-9]*\.?[0-9]+)?/g;

	let found = pattern.exec(withoutComments);
	while (found !== null) {
		words.push({
			letter: found[1].toUpperCase(),
			value: found[2] === undefined ? null : Number(found[2]),
		});
		found = pattern.exec(withoutComments);
	}

	return words;
}


/**
 * Reads a G-code program into a list of moves.
 *
 * @param {String} text - the program
 * @param {Object} [options] - options
 * @param {String} [options.units='mm'] - the unit assumed before any G20/G21
 * @returns {Object} `{ moves, warnings, stats }`. Each move is
 *   `{ kind, from, to, feed, spindle, tool, line }` where kind is `'rapid'`,
 *   `'feed'` or `'arc'`; arcs additionally carry `{ centre, clockwise, plane,
 *   radius, sweep }`. All positions are millimetres, whatever the file said
 */
export function parseGCode(text, options = {}) {

	const { units: startingUnits = 'mm' } = options;

	const moves = [];
	const warnings = [];
	const stats = { lines: 0, rapids: 0, feeds: 0, arcs: 0, fullCircles: 0 };

	let at = { x: 0, y: 0, z: 0 };
	let known = false;
	let motion = null;
	let plane = 'G17';
	let units = startingUnits;
	let absolute = true;
	let feed = null;
	let spindle = 0;
	let tool = null;

	const lines = text.split(/\r?\n/);

	for (let number = 0; number < lines.length; number++) {

		const words = readWords(lines[number]);
		if (words.length === 0)
			continue;

		stats.lines++;

		const axis = {};
		const offset = {};
		let radiusWord = null;
		let sawAxisWord = false;

		for (const { letter, value } of words) {

			if (letter === 'G') {
				const code = `G${value}`;
				if (MOTION.has(code))
					motion = code;
				else if (PLANES[code] !== undefined)
					plane = code;
				else if (code === 'G20')
					units = 'inch';
				else if (code === 'G21')
					units = 'mm';
				else if (code === 'G90')
					absolute = true;
				else if (code === 'G91')
					absolute = false;
				continue;
			}

			if (letter === 'M') {
				if (value === 3 || value === 4)
					spindle = spindle || 1;
				else if (value === 5)
					spindle = 0;
				continue;
			}

			const scale = units === 'inch' ? MM_PER_INCH : 1;

			if (letter === 'X' || letter === 'Y' || letter === 'Z') {
				axis[letter.toLowerCase()] = value * scale;
				sawAxisWord = true;
			} else if (letter === 'I' || letter === 'J' || letter === 'K') {
				offset[letter.toLowerCase()] = value * scale;
			} else if (letter === 'R') {
				radiusWord = value * scale;
			} else if (letter === 'F') {
				feed = value * scale;
			} else if (letter === 'S') {
				spindle = value;
			} else if (letter === 'T') {
				tool = value;
			}
		}

		// A line with no axis words commands no motion, whatever else is on it.
		// NCviewer emits a move for any line carrying a G-word, so `G21` alone
		// becomes a zero-length move and every consumer has to strain them out.
		if (!sawAxisWord || motion === null)
			continue;

		const to = { ...at };
		for (const name of ['x', 'y', 'z'])
			if (axis[name] !== undefined)
				to[name] = absolute ? axis[name] : at[name] + axis[name];

		const from = known ? { ...at } : { ...to };

		if (motion === 'G0' || motion === 'G1') {

			const kind = motion === 'G0' ? 'rapid' : 'feed';
			if (known && to.x === at.x && to.y === at.y && to.z === at.z) {
				at = to;
				continue;
			}
			moves.push({ kind, from, to, feed, spindle, tool, line: number + 1 });
			stats[kind === 'rapid' ? 'rapids' : 'feeds']++;

		} else {

			const arc = describeArc(from, to, offset, radiusWord, plane, motion === 'G2');

			if (arc === null) {
				warnings.push(`line ${number + 1}: an arc with no usable centre was skipped`);
				at = to;
				continue;
			}

			if (arc.full)
				stats.fullCircles++;

			moves.push({
				kind: 'arc', from, to, feed, spindle, tool, line: number + 1,
				centre: arc.centre, radius: arc.radius, sweep: arc.sweep,
				clockwise: motion === 'G2', plane,
			});
			stats.arcs++;
		}

		at = to;
		known = true;
	}

	return { moves, warnings, stats };
}


/**
 * Works out an arc's centre and sweep, from IJK or from R.
 *
 * @param {Object} from - start position
 * @param {Object} to - end position
 * @param {Object} offset - the i/j/k words present, millimetres
 * @param {Number|null} radiusWord - the R word, if any
 * @param {String} plane - G17, G18 or G19
 * @param {Boolean} clockwise - true for G2
 * @returns {Object|null} `{ centre, radius, sweep, full }`, or null if unusable
 */
function describeArc(from, to, offset, radiusWord, plane, clockwise) {

	const { axes, offsets } = PLANES[plane];
	const [u, v] = axes;
	const [ou, ov] = offsets;

	let centre;

	if (offset[ou] !== undefined || offset[ov] !== undefined) {

		// IJK are incremental from the start point, and belong to the axes of
		// the CURRENT plane -- NCviewer pairs them with the wrong axes in G18
		// and G19, which sends the arc somewhere else entirely
		centre = {
			[u]: from[u] + (offset[ou] ?? 0),
			[v]: from[v] + (offset[ov] ?? 0),
		};

	} else if (radiusWord !== null) {

		const du = to[u] - from[u];
		const dv = to[v] - from[v];
		const chord = Math.hypot(du, dv);

		if (chord === 0 || Math.abs(radiusWord) * 2 < chord - 1e-9)
			return null;

		const radius = Math.abs(radiusWord);
		const height = Math.sqrt(Math.max(0, (radius * radius) - ((chord / 2) * (chord / 2))));

		// A NEGATIVE R asks for the major arc -- the long way round. NCviewer
		// takes the absolute value and always cuts the short way, which is a
		// different arc through the same two points.
		const major = radiusWord < 0;
		const side = (clockwise === major) ? 1 : -1;

		centre = {
			[u]: from[u] + (du / 2) + ((side * height * -dv) / chord),
			[v]: from[v] + (dv / 2) + ((side * height * du) / chord),
		};

	} else {
		return null;
	}

	const radius = Math.hypot(from[u] - centre[u], from[v] - centre[v]);
	const startAngle = Math.atan2(from[v] - centre[v], from[u] - centre[u]);
	const endAngle = Math.atan2(to[v] - centre[v], to[u] - centre[u]);

	// Coincident endpoints mean a FULL circle, which is exactly what IJK with no
	// axis movement is for. NCviewer computes a zero sweep here and drops the
	// move, losing the one arc it is least safe to lose.
	const full = Math.abs(to[u] - from[u]) < 1e-9 && Math.abs(to[v] - from[v]) < 1e-9;

	let sweep;
	if (full) {
		sweep = clockwise ? -2 * Math.PI : 2 * Math.PI;
	} else {
		sweep = endAngle - startAngle;
		if (clockwise)
			while (sweep >= 0) sweep -= 2 * Math.PI;
		else
			while (sweep <= 0) sweep += 2 * Math.PI;
	}

	return { centre: { ...from, ...centre }, radius, sweep, full };
}


/**
 * Flattens parsed moves into the motion a machine would actually make.
 *
 * @param {Array<Object>} moves - from parseGCode
 * @param {Object} [options] - options
 * @param {Number} [options.tolerance=0.01] - chord tolerance for arcs, millimetres
 * @returns {Array<Object>} `{ kind, points }` per move, points in millimetres
 */
export function flattenMoves(moves, options = {}) {

	const { tolerance = 0.01 } = options;

	return moves.map((move) => {

		if (move.kind !== 'arc')
			return { kind: move.kind, points: [move.from, move.to].map((p) => [p.x, p.y, p.z]) };

		const { axes, normal } = PLANES[move.plane];
		const [u, v] = axes;
		const { centre, radius, sweep } = move;

		// enough steps that the chords sit within tolerance of the true arc
		const step = radius > tolerance
			? 2 * Math.acos(1 - (tolerance / radius))
			: Math.PI / 2;
		const steps = Math.max(2, Math.ceil(Math.abs(sweep) / step));

		const startAngle = Math.atan2(move.from[v] - centre[v], move.from[u] - centre[u]);
		const points = [];

		for (let i = 0; i <= steps; i++) {
			const angle = startAngle + (sweep * (i / steps));
			const point = { [normal]: move.from[normal] + (((move.to[normal] - move.from[normal]) * i) / steps) };
			point[u] = centre[u] + (radius * Math.cos(angle));
			point[v] = centre[v] + (radius * Math.sin(angle));
			points.push([point.x, point.y, point.z]);
		}

		return { kind: 'arc', points };
	});
}
