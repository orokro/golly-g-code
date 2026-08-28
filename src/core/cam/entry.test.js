import { describe, it, expect } from 'vitest';
import { rampEntry, rampDistance, leadIn, leadOut, Side, DEFAULT_RAMP_ANGLE } from './entry.js';

const line = [[0, 0], [200, 0]];


describe('how far a ramp has to travel', () => {

	it('is set by the angle the tool can manage', () => {
		// 1mm down at 3 degrees needs 1/tan(3deg) of travel
		expect(rampDistance(1, { angleRadians: DEFAULT_RAMP_ANGLE }))
			.toBeCloseTo(1 / Math.tan(DEFAULT_RAMP_ANGLE), 6);
	});

	it('is stretched when a straight plunge would have taken longer anyway', () => {
		// dropping 1mm at 300mm/min takes the same time as 3mm of travel at
		// 900mm/min, so ramping over that distance is free
		const free = rampDistance(1, { angleRadians: Math.PI / 4, cutFeed: 900, plungeFeed: 300 });
		expect(free).toBeCloseTo(3, 6);
	});

	it('never goes steeper than the angle allows, whatever the feeds say', () => {
		const steep = rampDistance(1, { angleRadians: DEFAULT_RAMP_ANGLE, cutFeed: 10, plungeFeed: 9000 });
		expect(steep).toBeCloseTo(1 / Math.tan(DEFAULT_RAMP_ANGLE), 6);
	});

	it('rejects an angle that is not a ramp', () => {
		expect(() => rampDistance(1, { angleRadians: 0 })).toThrow(RangeError);
		expect(() => rampDistance(1, { angleRadians: Math.PI })).toThrow(RangeError);
	});
});


describe('ramping in', () => {

	it('arrives back at the start of the line, at full depth', () => {
		const { points } = rampEntry(line, 0, -1, { angleRadians: DEFAULT_RAMP_ANGLE });
		const last = points[points.length - 1];

		expect(last[0]).toBeCloseTo(0, 6);
		expect(last[1]).toBeCloseTo(0, 6);
		expect(last[2]).toBeCloseTo(-1, 6);
	});

	it('starts where the cut starts, at the depth it was handed', () => {
		const { points } = rampEntry(line, 0, -1);
		expect(points[0]).toEqual([0, 0, 0]);
	});

	it('goes out and comes back, rather than only forward', () => {
		// forward-only would reach depth partway along, leaving the first stretch
		// shallow — and on the last pass that stretch never gets cut at all
		const { points } = rampEntry(line, 0, -1, { angleRadians: DEFAULT_RAMP_ANGLE });
		const furthest = Math.max(...points.map((p) => p[0]));

		expect(furthest).toBeGreaterThan(0);
		expect(points[points.length - 1][0]).toBeCloseTo(0, 6);
	});

	it('descends the whole way, never climbing', () => {
		const { points } = rampEntry(line, 0, -1);
		for (let i = 1; i < points.length; i++)
			expect(points[i][2]).toBeLessThanOrEqual(points[i - 1][2] + 1e-9);
	});

	it('never exceeds the angle it was given', () => {
		const { points } = rampEntry(line, 0, -1.5, { angleRadians: DEFAULT_RAMP_ANGLE });
		for (let i = 1; i < points.length; i++) {
			const along = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
			const down = points[i - 1][2] - points[i][2];
			if (along > 0)
				expect(Math.atan2(down, along)).toBeLessThanOrEqual(DEFAULT_RAMP_ANGLE + 1e-6);
		}
	});

	it('follows the path rather than cutting across it', () => {
		const corner = [[0, 0], [20, 0], [20, 20]];
		const { points } = rampEntry(corner, 0, -0.2, { angleRadians: Math.PI / 8 });
		// every ramp point is on the path, so it never leaves the cut
		for (const [x, y] of points) {
			const onFirst = y === 0 && x >= -1e-9 && x <= 20 + 1e-9;
			const onSecond = Math.abs(x - 20) < 1e-9 && y >= -1e-9;
			expect(onFirst || onSecond, `${x},${y}`).toBe(true);
		}
	});

	it('says so when the path is too short to ramp gently', () => {
		const stub = [[0, 0], [2, 0]];
		const { points, warnings } = rampEntry(stub, 0, -5, { angleRadians: DEFAULT_RAMP_ANGLE });

		expect(warnings.join(' ')).toMatch(/too short|more steeply|wants/);
		// and it still arrives at depth at the start rather than giving up
		expect(points[points.length - 1][2]).toBeCloseTo(-5, 6);
	});

	it('refuses a ramp that does not descend', () => {
		expect(() => rampEntry(line, -1, 0)).toThrow(RangeError);
		expect(() => rampEntry(line, 0, 0)).toThrow(RangeError);
	});
});


describe('leads', () => {

	it('arrives exactly on the start of the cut', () => {
		const points = leadIn(line, { radius: 3 });
		const last = points[points.length - 1];
		const next = line[0];
		// the arc stops one step short; the path itself supplies the last point
		expect(Math.hypot(last[0] - next[0], last[1] - next[1])).toBeLessThan(1);
	});

	it('arrives tangentially, not head-on', () => {
		// the last step of the lead points the same way as the first step of the
		// cut — that is the whole purpose
		const points = [...leadIn(line, { radius: 3 }), line[0]];
		const n = points.length;
		const lead = [points[n - 1][0] - points[n - 2][0], points[n - 1][1] - points[n - 2][1]];
		const cut = [line[1][0] - line[0][0], line[1][1] - line[0][1]];

		const angle = Math.abs(Math.atan2(lead[1], lead[0]) - Math.atan2(cut[1], cut[0]));
		expect(Math.min(angle, (2 * Math.PI) - angle)).toBeLessThan(0.15);
	});

	it('comes from the side it was told to, and never guesses', () => {
		const left = leadIn(line, { radius: 3, side: Side.LEFT });
		const right = leadIn(line, { radius: 3, side: Side.RIGHT });

		expect(Math.max(...left.map((p) => p[1]))).toBeGreaterThan(0);
		expect(Math.min(...right.map((p) => p[1]))).toBeLessThan(0);
	});

	it('stays within a lead radius of where it joins', () => {
		for (const radius of [0.5, 2, 6]) {
			const points = leadIn(line, { radius });
			for (const [x, y] of points)
				expect(Math.hypot(x, y), `${radius}`).toBeLessThanOrEqual((radius * 2) + 1e-6);
		}
	});

	it('leads out of the end the mirror of leading in', () => {
		const out = leadOut(line, { radius: 3, side: Side.LEFT });
		expect(out.length).toBeGreaterThan(0);

		// it departs from the end of the cut, on the same side
		const first = out[0];
		expect(Math.hypot(first[0] - 200, first[1] - 0)).toBeLessThan(3.1);
		expect(Math.max(...out.map((p) => p[1]))).toBeGreaterThan(0);
	});

	it('refuses an unusable radius or sweep', () => {
		expect(() => leadIn(line, { radius: 0 })).toThrow(RangeError);
		expect(() => leadIn(line, { sweepRadians: 0 })).toThrow(RangeError);
		expect(() => leadIn(line, { sweepRadians: Math.PI * 1.5 })).toThrow(RangeError);
	});

	it('does nothing to a path with no direction', () => {
		expect(leadIn([[0, 0]], { radius: 2 })).toEqual([]);
		expect(leadIn([[0, 0], [0, 0]], { radius: 2 })).toEqual([]);
	});
});
