/**
 * @file entry.js
 * @description How the tool gets into the cut: ramps and leads.
 *
 * Both exist for the same reason. An end mill cutting straight down is doing the
 * thing it is worst at — most of them have poor or no centre cutting geometry,
 * so a vertical plunge rubs rather than cuts, heats the tip, and leaves a mark
 * at the one spot the tool dwells longest. Getting in sideways instead is worth
 * a little extra travel.
 *
 * ## Ramp: descend while moving
 *
 * Instead of dropping onto the start of the line, travel along it descending,
 * then come back, arriving at the start at full depth. The there-and-back
 * matters: a ramp that only goes forward reaches depth some way along, leaving
 * the first stretch shallow, and on the final pass that stretch never gets cut.
 * Coming back means the whole line is cut at full depth from its first
 * millimetre.
 *
 * The distance is the larger of two limits, so both hold:
 *
 * - **the angle the tool can manage**, which is the physical one
 * - **the distance travelled in the time a straight plunge would have taken**,
 *   which is jscut's idea and a good one — below it the ramp is free, since the
 *   machine would have spent that time descending anyway
 *
 * ## Lead: enter from the side
 *
 * A tangential arc onto the start of the cut, so the tool is already moving
 * along the finished edge when it reaches it rather than arriving at it head-on.
 *
 * **Which side is scrap is not inferable.** An open path has no interior, and
 * even on a closed one the program cannot know which side of the line the part
 * is. Greg: *"we probably should have some kind of UI as well for picking where
 * the leads go (its not obvious what will be considered scrap automatically)."*
 * So the side is a parameter with a default, never a guess, and nothing here
 * tries to detect it.
 */

/** Steepest ramp a general-purpose end mill is asked to manage. */
export const DEFAULT_RAMP_ANGLE = (3 * Math.PI) / 180;

/** Which side of the path a lead approaches from. */
export const Side = Object.freeze({ LEFT: 'left', RIGHT: 'right' });


/**
 * Cumulative length at each vertex.
 *
 * @param {Array<Number[]>} path - the polyline
 * @returns {Number[]} one length per vertex
 */
function lengths(path) {
	const out = [0];
	for (let i = 0; i + 1 < path.length; i++)
		out.push(out[i] + Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]));
	return out;
}


/**
 * The point a distance along a path.
 *
 * @param {Array<Number[]>} path - the polyline
 * @param {Number} distance - arc length from the start
 * @param {Number[]} table - precomputed lengths
 * @returns {Number[]} the point
 */
function at(path, distance, table) {

	const total = table[table.length - 1];

	if (distance <= 0 || total === 0)
		return [...path[0]];
	if (distance >= total)
		return [...path[path.length - 1]];

	let hi = 1;
	while (table[hi] < distance)
		hi++;

	const span = table[hi] - table[hi - 1];
	const t = span === 0 ? 0 : (distance - table[hi - 1]) / span;

	return [
		path[hi - 1][0] + (t * (path[hi][0] - path[hi - 1][0])),
		path[hi - 1][1] + (t * (path[hi][1] - path[hi - 1][1])),
	];
}


/**
 * How far a ramp needs to travel to descend a given depth.
 *
 * @param {Number} drop - how far down, positive millimetres
 * @param {Object} [options] - options
 * @param {Number} [options.angleRadians=DEFAULT_RAMP_ANGLE] - steepest allowed
 * @param {Number} [options.cutFeed] - feed along the path, mm/min
 * @param {Number} [options.plungeFeed] - feed straight down, mm/min
 * @returns {Number} the along-path distance, millimetres
 * @throws {RangeError} when the angle is not usable
 */
export function rampDistance(drop, options = {}) {

	const { angleRadians = DEFAULT_RAMP_ANGLE, cutFeed, plungeFeed } = options;

	if (!(angleRadians > 0 && angleRadians < Math.PI / 2))
		throw new RangeError(`ramp angle must be between 0 and 90 degrees, got ${angleRadians}`);

	if (!(drop > 0))
		return 0;

	const byAngle = drop / Math.tan(angleRadians);

	// the distance covered at cutting feed in the time a straight plunge would
	// have taken; below this the ramp costs nothing
	const byTime = (cutFeed > 0 && plungeFeed > 0)
		? (cutFeed * drop) / plungeFeed
		: 0;

	return Math.max(byAngle, byTime);
}


/**
 * Builds a ramped entry: out along the path descending, then back to the start.
 *
 * @param {Array<Number[]>} path - the toolpath, starting where the cut starts
 * @param {Number} fromZ - Z to start descending from
 * @param {Number} toZ - Z to arrive at, below fromZ
 * @param {Object} [options] - options, as rampDistance
 * @returns {Object} `{ points, warnings }` — points are `[x, y, z]`, beginning
 *   at the start of the path at `fromZ` and ending there again at `toZ`, so the
 *   cut proper then runs the whole path at full depth
 * @throws {RangeError} when the drop is not downward
 */
export function rampEntry(path, fromZ, toZ, options = {}) {

	if (!(fromZ > toZ))
		throw new RangeError(`a ramp must descend: given ${fromZ} to ${toZ}`);

	if (path.length < 2)
		return { points: [[...path[0], toZ]], warnings: [] };

	const warnings = [];
	const table = lengths(path);
	const total = table[table.length - 1];
	const drop = fromZ - toZ;

	let reach = rampDistance(drop, options);

	// The ramp goes out and comes back, so it needs half its distance of path.
	// A path too short for that gets the shallowest ramp it can, which is still
	// better than dropping straight in.
	if (reach > total) {
		warnings.push(`the path is ${total.toFixed(1)}mm long but a ${drop}mm ramp wants`
			+ ` ${reach.toFixed(1)}mm; ramping over the whole path instead, more steeply`);
		reach = total;
	}

	const out = reach / 2;
	const points = [];

	// descend on the way out, and keep descending on the way back, so the tool
	// arrives at the start of the line already at depth
	const walk = (distance, z) => {
		const [x, y] = at(path, distance, table);
		points.push([x, y, z]);
	};

	const steps = Math.max(2, Math.ceil(out / 0.5));

	walk(0, fromZ);
	for (let i = 1; i <= steps; i++)
		walk((out * i) / steps, fromZ - ((drop * i) / (steps * 2)));
	for (let i = 1; i <= steps; i++)
		walk(out - ((out * i) / steps), fromZ - (drop / 2) - ((drop * i) / (steps * 2)));

	return { points, warnings };
}


/**
 * A tangential arc leading into the start of a cut.
 *
 * The tool comes round onto the line rather than at it, so it is already moving
 * along the finished edge by the time it touches it, and the entry mark lands
 * wherever the caller decided the scrap is.
 *
 * @param {Array<Number[]>} path - the toolpath
 * @param {Object} [options] - options
 * @param {Number} [options.radius=1] - arc radius, millimetres
 * @param {String} [options.side=Side.LEFT] - which side to come from. NOT
 *   inferred: the program cannot know which side is scrap
 * @param {Number} [options.sweepRadians=Math.PI/2] - how much of a turn
 * @param {Number} [options.tolerance=0.01] - chord tolerance for the arc
 * @returns {Array<Number[]>} points to run BEFORE the path, ending exactly on
 *   `path[0]`; empty when the path is too short to have a direction
 * @throws {RangeError} for an unusable radius or sweep
 */
export function leadIn(path, options = {}) {

	const {
		radius = 1,
		side = Side.LEFT,
		sweepRadians = Math.PI / 2,
		tolerance = 0.01,
	} = options;

	if (!(radius > 0))
		throw new RangeError(`lead radius must be positive, got ${radius}`);

	if (!(sweepRadians > 0 && sweepRadians <= Math.PI))
		throw new RangeError(`lead sweep must be between 0 and half a turn, got ${sweepRadians}`);

	if (path.length < 2)
		return [];

	const [ax, ay] = path[0];
	const vx = path[1][0] - ax;
	const vy = path[1][1] - ay;
	const length = Math.hypot(vx, vy);

	if (length === 0)
		return [];

	// centre sits one radius off to the chosen side, so the arc arrives tangent
	const hand = side === Side.RIGHT ? -1 : 1;
	const cx = ax + ((hand * -vy * radius) / length);
	const cy = ay + ((hand * vx * radius) / length);

	const endAngle = Math.atan2(ay - cy, ax - cx);
	const startAngle = endAngle - (hand * sweepRadians);

	const step = radius > tolerance ? 2 * Math.acos(1 - (tolerance / radius)) : Math.PI / 2;
	const steps = Math.max(2, Math.ceil(sweepRadians / step));

	const points = [];
	for (let i = 0; i < steps; i++) {
		const angle = startAngle + ((endAngle - startAngle) * (i / steps));
		points.push([cx + (radius * Math.cos(angle)), cy + (radius * Math.sin(angle))]);
	}

	return points;
}


/**
 * A tangential arc leading out of the end of a cut.
 *
 * @param {Array<Number[]>} path - the toolpath
 * @param {Object} [options] - as leadIn
 * @returns {Array<Number[]>} points to run AFTER the path, starting at its end
 */
export function leadOut(path, options = {}) {

	// the lead out of the end is the lead into the reversed path, reversed
	const reversed = [...path].reverse();
	const { side = Side.LEFT } = options;

	return leadIn(reversed, {
		...options,
		side: side === Side.LEFT ? Side.RIGHT : Side.LEFT,
	}).reverse();
}
