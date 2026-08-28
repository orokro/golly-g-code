/**
 * @file tabs.js
 * @description Holding tabs — the slivers of material left uncut so a part does
 * not come loose and get thrown while the last pass finishes.
 *
 * ## What jscut does, and why none of it is reused
 *
 * jscut's `separateTabs` lives in a gitignored emscripten blob whose CDN
 * fallback is dead, so in practice tabs simply do not work. The pure-JS fallback
 * that remains has a return-type bug and emits `G1 XNaN YNaN`. Tabs are also
 * placed by drawing a closed shape over the drawing and intersecting with it,
 * which means a tab is a REGION rather than a position, and its size is
 * expressed as a fraction rather than in millimetres.
 *
 * ## A tab is a BREAK in the cut
 *
 * Not a ride-over at reduced depth. The tool retracts fully to safe Z, rapids
 * across the tab, plunges, and carries on. Greg's call: *"they should just be
 * breaks in the cut placed wherever I want... that might not be the most optimal
 * path, but eh its logical enough."* It is also far easier to reason about at
 * the machine, and it keeps the cutter out of the tab entirely rather than
 * skimming its top.
 *
 * **Tab depth is a depth**, measured down from the material surface exactly like
 * cut depth, and the material left under the tab is whatever is below it. In
 * 4mm stock cut to 5mm (into the spoilboard) with 1mm passes, a tab at 3mm
 * leaves 1mm of material standing. A tab at 0 is never cut at all.
 *
 * A tab therefore only breaks the passes that would cut BELOW it. That same job
 * runs its first three passes straight through the tab as if it were not there,
 * and breaks only on the fourth and fifth.
 *
 * (Cutting each unbroken run between tabs to full depth before moving to the
 * next — rather than a pass at a time across the whole path — would save
 * retracts. Greg: *"that's less interesting."* Not done.)
 *
 * ## Where a tab lives
 *
 * A tab is anchored to the **source path**, as a normalised position along its
 * arc length, with a length in real millimetres. Not to the toolpath, and not as
 * a percentage.
 *
 * That choice is the whole design, and it follows from what a tab physically is:
 * a bridge of material of a certain width, in a certain place on the part. Both
 * of those are properties of the part, not of whatever cutter happens to be
 * fitted. Anchor a tab to the toolpath instead and swapping a 1/8" bit for a
 * 1/4" one moves every tab and changes every tab's width, because the toolpath
 * moved. Anchor it to the source and neither happens: an 8mm tab is 8mm of
 * material, wherever the toolpath ends up.
 *
 * The tab is resolved onto the toolpath at generation time, by projecting both
 * of its ends onto the nearest point of the toolpath. On the outside of a curve
 * the tool travels further than 8mm to cross an 8mm bridge, and on the inside it
 * travels less; that is correct, and it is exactly the difference that anchoring
 * to the toolpath would get wrong.
 *
 * ## The bridge is a wedge, not a rectangle
 *
 * Worth being exact about, because it decides whether the length asked for is
 * the length delivered. The cutter is a disc of radius r whose centre runs one
 * offset out from the line, so at full depth it TOUCHES the line at a single
 * point and never crosses it. Lift it over a span and the material left standing
 * measures, at the part edge, exactly that span — no more, no less.
 *
 * Further out into the kerf it is another story. The disc reaches r ahead of and
 * behind its centre, so at the far side of the kerf the bridge has lost r at
 * each end: a tab of length L is L at the part edge and L − 2r at the outer edge,
 * tapering between. That is fine for a tab comfortably wider than the cutter and
 * meaningless for one that is not — at L = 2r the bridge comes to a knife edge
 * carrying nothing, and below it the two cuts simply meet.
 *
 * So the length is measured where the user would measure it, at the part edge,
 * and `placeTabs` says so when a tab is too narrow for the cutter to leave
 * anything behind it.
 */

/**
 * Cumulative arc length at each vertex of a path.
 *
 * @param {Array<Number[]>} path - the polyline
 * @returns {Number[]} one length per vertex, starting at zero
 */
export function arcLengths(path) {

	const lengths = [0];

	for (let i = 0; i + 1 < path.length; i++)
		lengths.push(lengths[i] + Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]));

	return lengths;
}


/**
 * The point a given distance along a path.
 *
 * @param {Array<Number[]>} path - the polyline
 * @param {Number} distance - arc length from the start, millimetres
 * @param {Number[]} [lengths] - precomputed arc lengths, if the caller has them
 * @returns {Number[]} the point, clamped to the ends
 */
export function pointAt(path, distance, lengths = arcLengths(path)) {

	const total = lengths[lengths.length - 1];

	if (path.length === 0)
		throw new RangeError('pointAt needs a path with at least one point');

	if (distance <= 0 || total === 0)
		return [...path[0]];

	if (distance >= total)
		return [...path[path.length - 1]];

	// first vertex at or past the distance; the point lies on the segment before it
	let hi = 1;
	while (lengths[hi] < distance)
		hi++;

	const span = lengths[hi] - lengths[hi - 1];
	const t = span === 0 ? 0 : (distance - lengths[hi - 1]) / span;

	return [
		path[hi - 1][0] + (t * (path[hi][0] - path[hi - 1][0])),
		path[hi - 1][1] + (t * (path[hi][1] - path[hi - 1][1])),
	];
}


/**
 * Arc length along a path of the point nearest a given point.
 *
 * @param {Array<Number[]>} path - the polyline
 * @param {Number[]} point - the point to project
 * @param {Number[]} [lengths] - precomputed arc lengths
 * @returns {Object} `{ distance, offset }` — arc length of the nearest point,
 *   and how far the point was from the path
 */
export function projectOnto(path, point, lengths = arcLengths(path)) {

	let best = { distance: 0, offset: Infinity };

	for (let i = 0; i + 1 < path.length; i++) {

		const [ax, ay] = path[i];
		const [bx, by] = path[i + 1];
		const vx = bx - ax;
		const vy = by - ay;
		const lengthSquared = (vx * vx) + (vy * vy);

		let t = lengthSquared === 0
			? 0
			: ((((point[0] - ax) * vx) + ((point[1] - ay) * vy)) / lengthSquared);
		t = Math.max(0, Math.min(1, t));

		const offset = Math.hypot(point[0] - (ax + (t * vx)), point[1] - (ay + (t * vy)));

		if (offset < best.offset)
			best = { distance: lengths[i] + (t * Math.sqrt(lengthSquared)), offset };
	}

	return best;
}


/**
 * Places tabs from the source path onto the toolpath.
 *
 * Each tab's two ends are measured along the SOURCE in millimetres, then
 * projected onto the toolpath — see the file header for why that way round.
 * Overlapping tabs are merged, because two tabs sharing material are one bridge
 * and emitting them separately would put a pointless Z wobble in the middle of
 * it.
 *
 * @param {Array<Number[]>} source - the path the tabs are anchored to
 * @param {Array<Number[]>} toolpath - the offset path the tool will follow
 * @param {Array<Object>} tabs - each `{ position, length, depth }`; position is
 *   normalised 0..1 along the source, length and depth are millimetres, and
 *   length and depth each fall back to the job default when not given
 * @param {Object} [options] - options
 * @param {Number} [options.defaultLength=6] - length for tabs that do not set one
 * @param {Number} [options.defaultDepth=0] - depth for tabs that do not set one;
 *   zero means the tab is never cut into at all
 * @param {Number} [options.toolRadius] - cutter radius; supplied only so a tab
 *   too narrow to leave a bridge can be reported. It does not move anything
 * @returns {Object} `{ spans, warnings }` — spans are `{ start, end, depth }`,
 *   arc lengths along the TOOLPATH, sorted and non-overlapping
 * @throws {RangeError} when a tab is malformed
 */
export function placeTabs(source, toolpath, tabs, options = {}) {

	const { toolRadius, defaultLength = 6, defaultDepth = 0 } = options;

	const warnings = [];

	if (source.length < 2 || toolpath.length < 2)
		return { spans: [], warnings };

	const sourceLengths = arcLengths(source);
	const toolLengths = arcLengths(toolpath);
	const sourceTotal = sourceLengths[sourceLengths.length - 1];
	const toolTotal = toolLengths[toolLengths.length - 1];

	const raw = [];

	for (const tab of tabs) {

		const { position } = tab;
		const length = tab.length ?? defaultLength;
		const depth = tab.depth ?? defaultDepth;

		if (!(position >= 0 && position <= 1))
			throw new RangeError(`tab position must be within 0..1, got ${position}`);

		if (!(length > 0))
			throw new RangeError(`tab length must be positive, got ${length}`);

		if (!(depth >= 0))
			throw new RangeError(`tab depth must be zero or more, got ${depth}`);

		if (toolRadius > 0 && length <= toolRadius * 2)
			warnings.push(`a ${length}mm tab is not wider than the ${(toolRadius * 2).toFixed(3)}mm`
				+ ' cutter, so it tapers to nothing across the kerf and will hold very little');

		if (length >= sourceTotal) {
			warnings.push(`a tab ${length}mm long does not fit on a ${sourceTotal.toFixed(1)}mm path`
				+ ' and would leave the part uncut; it was skipped');
			continue;
		}

		// both ends measured on the source, so the bridge is the width asked for
		const middle = position * sourceTotal;
		const from = pointAt(source, middle - (length / 2), sourceLengths);
		const to = pointAt(source, middle + (length / 2), sourceLengths);

		const a = projectOnto(toolpath, from, toolLengths);
		const b = projectOnto(toolpath, to, toolLengths);

		// Where the source has a feature the cutter cannot enter, the toolpath
		// runs past it rather than into it, and a tab end there is nowhere near
		// the toolpath. The material stays put regardless -- the tool never
		// reaches it -- but the tab is not doing the job it was placed to do,
		// and that is not something to find out by looking at the part.
		const reach = Math.min(a.offset, b.offset) * 1.5;
		if (Math.max(a.offset, b.offset) > Math.max(reach, 0.01))
			warnings.push(`the tab at ${position} sits where the cutter cannot follow the line;`
				+ ' the material there is already uncut, so the tab adds nothing');

		raw.push({
			start: Math.min(a.distance, b.distance),
			end: Math.max(a.distance, b.distance),
			depth,
		});
	}

	// merge overlaps: two tabs sharing material are one bridge
	raw.sort((x, y) => x.start - y.start);

	const spans = [];
	for (const span of raw) {
		const last = spans[spans.length - 1];
		if (last !== undefined && span.start <= last.end) {
			last.end = Math.max(last.end, span.end);
			// the shallower of the two wins: a merged tab leaves the most material
			// either of them asked for, rather than the least
			last.depth = Math.min(last.depth, span.depth);
		} else {
			spans.push({ ...span });
		}
	}

	if (spans.length > 0 && spans.length < raw.length)
		warnings.push(`${raw.length - spans.length} tab(s) overlapped and were merged`);

	// a tab spanning the whole toolpath would mean nothing gets cut
	if (spans.length === 1 && spans[0].start <= 0 && spans[0].end >= toolTotal)
		warnings.push('the tabs cover the entire toolpath, so nothing would be cut');

	return { spans, warnings };
}


/**
 * Whether a tab breaks the cut on a given pass.
 *
 * A tab only matters once the pass would take the cutter below it. Passes above
 * it run straight through as if it were not there.
 *
 * @param {Number} passZ - Z of this depth pass, negative below the surface
 * @param {Number} depth - the tab's depth from the surface, positive millimetres
 * @param {Number} [topZ=0] - Z of the material surface
 * @returns {Boolean} true if the path must break here on this pass
 */
export function tabBreaks(passZ, depth, topZ = 0) {

	if (!(depth >= 0))
		throw new RangeError(`tab depth must be zero or more, got ${depth}`);

	return passZ < topZ - depth;
}


/**
 * The runs of toolpath actually cut on one depth pass.
 *
 * Everything not returned is a gap: retract to safe Z, rapid across, plunge, and
 * pick up at the next run. The gaps are left implicit rather than described,
 * because how to leave and re-enter the cut is the post-processor's business
 * (and lead-ins, 1.8, will want a say).
 *
 * A pass above every tab comes back as the whole toolpath in one run, which is
 * the common case for the first few passes of a deep cut.
 *
 * @param {Array<Number[]>} toolpath - the path for this pass
 * @param {Array<Object>} spans - `{ start, end, depth }`, sorted and merged
 * @param {Number} passZ - Z of this pass, negative below the surface
 * @param {Object} [options] - options
 * @param {Number} [options.topZ=0] - Z of the material surface
 * @returns {Array<Object>} `{ points, start, end }` runs to cut, in travel order
 */
export function planPass(toolpath, spans, passZ, options = {}) {

	const { topZ = 0 } = options;

	if (toolpath.length < 2)
		return toolpath.length === 0 ? [] : [{ points: [...toolpath], start: 0, end: 0 }];

	const lengths = arcLengths(toolpath);
	const total = lengths[lengths.length - 1];

	const breaking = spans
		.filter(({ depth }) => tabBreaks(passZ, depth, topZ))
		.map(({ start, end }) => ({ start: Math.max(0, start), end: Math.min(total, end) }))
		.filter(({ start, end }) => end > start);

	if (breaking.length === 0)
		return [{ points: [...toolpath], start: 0, end: total }];

	const runs = [];
	let at = 0;

	for (const gap of [...breaking, { start: total, end: total }]) {

		if (gap.start > at)
			runs.push(cutRun(toolpath, lengths, at, gap.start));

		at = Math.max(at, gap.end);
	}

	return runs;
}


/**
 * One run of toolpath between two arc lengths, with exact ends.
 *
 * @param {Array<Number[]>} toolpath - the path
 * @param {Number[]} lengths - its cumulative arc lengths
 * @param {Number} from - arc length to start at
 * @param {Number} to - arc length to stop at
 * @returns {Object} `{ points, start, end }`
 */
function cutRun(toolpath, lengths, from, to) {

	const points = [pointAt(toolpath, from, lengths)];

	// the path's own vertices strictly inside the run, so the shape is kept
	for (let v = 0; v < toolpath.length; v++)
		if (lengths[v] > from && lengths[v] < to)
			points.push([...toolpath[v]]);

	points.push(pointAt(toolpath, to, lengths));

	return { points, start: from, end: to };
}
