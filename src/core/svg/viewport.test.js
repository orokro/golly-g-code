import { describe, it, expect } from 'vitest';
import {
	resolveViewport, parseLengthToMillimeters, parseViewBox,
	parsePreserveAspectRatio, MM_PER_PX, CSS_PX_PER_INCH,
} from './viewport.js';
import { applyToPoint } from './matrix.js';

const svg = (attrs) => ({
	nodeName: 'svg',
	getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? String(attrs[k]) : null),
});

const at = (result, point) => applyToPoint(result.matrix, point);


describe('length parsing', () => {

	it('handles every absolute CSS unit', () => {
		expect(parseLengthToMillimeters('100mm')).toBeCloseTo(100, 9);
		expect(parseLengthToMillimeters('10cm')).toBeCloseTo(100, 9);
		expect(parseLengthToMillimeters('1in')).toBeCloseTo(25.4, 9);
		expect(parseLengthToMillimeters('72pt')).toBeCloseTo(25.4, 9);
		expect(parseLengthToMillimeters('6pc')).toBeCloseTo(25.4, 9);
		expect(parseLengthToMillimeters('96px')).toBeCloseTo(25.4, 9);
		expect(parseLengthToMillimeters('40q')).toBeCloseTo(10, 9);
	});

	it('treats a bare number as CSS pixels', () => {
		expect(parseLengthToMillimeters('96')).toBeCloseTo(25.4, 9);
	});

	it('tolerates whitespace and decimals', () => {
		expect(parseLengthToMillimeters('  8.5 in ')).toBeCloseTo(215.9, 9);
	});

	it('rejects relative units rather than guessing', () => {
		for (const bad of ['100%', '2em', '3ex', '5rem', '10vw', 'auto', '', null, undefined])
			expect(parseLengthToMillimeters(bad)).toBeNull();
	});
});


describe('viewBox parsing', () => {

	it('accepts commas or whitespace', () => {
		expect(parseViewBox('0 0 200 100')).toEqual({ minX: 0, minY: 0, width: 200, height: 100 });
		expect(parseViewBox('0,0,200,100')).toEqual({ minX: 0, minY: 0, width: 200, height: 100 });
	});

	it('keeps a non-zero origin', () => {
		expect(parseViewBox('-50 -25 200 100')).toEqual({ minX: -50, minY: -25, width: 200, height: 100 });
	});

	it('rejects degenerate or malformed boxes', () => {
		for (const bad of ['0 0 0 100', '0 0 200 0', '0 0 -5 10', '0 0 200', 'a b c d', '', null])
			expect(parseViewBox(bad)).toBeNull();
	});
});


describe('preserveAspectRatio parsing', () => {

	it('defaults to xMidYMid meet', () => {
		expect(parsePreserveAspectRatio(null)).toEqual({ align: 'xMidYMid', meetOrSlice: 'meet' });
	});

	it('reads align and meetOrSlice', () => {
		expect(parsePreserveAspectRatio('xMinYMax slice')).toEqual({ align: 'xMinYMax', meetOrSlice: 'slice' });
		expect(parsePreserveAspectRatio('none')).toEqual({ align: 'none', meetOrSlice: 'meet' });
	});
});


describe('the case jscut throws away: a stated size WITH a viewBox', () => {

	it('derives the real scale instead of asking for a px-per-inch guess', () => {
		// 100mm wide across 200 user units: one unit is half a millimetre
		const result = resolveViewport(svg({ width: '100mm', height: '50mm', viewBox: '0 0 200 100' }));

		expect(result.source).toBe('width-height+viewBox');
		expect(result.scaleX).toBeCloseTo(0.5, 9);
		expect(result.physical).toEqual({ width: 100, height: 50 });
		expect(result.warnings).toHaveLength(0);
	});

	it('flips y so the document lands in our y-up space', () => {
		const result = resolveViewport(svg({ width: '100mm', height: '50mm', viewBox: '0 0 200 100' }));

		// SVG's top-left becomes the top-left of a y-up box: y = full height
		const topLeft = at(result, [0, 0]);
		expect(topLeft[0]).toBeCloseTo(0, 9);
		expect(topLeft[1]).toBeCloseTo(50, 9);

		// SVG's bottom-right becomes the origin
		const bottomRight = at(result, [200, 100]);
		expect(bottomRight[0]).toBeCloseTo(100, 9);
		expect(bottomRight[1]).toBeCloseTo(0, 9);
	});

	it('honours a non-zero viewBox origin', () => {
		const result = resolveViewport(svg({ width: '100mm', height: '50mm', viewBox: '-50 -25 200 100' }));
		const origin = at(result, [-50, -25]);
		expect(origin[0]).toBeCloseTo(0, 9);
		expect(origin[1]).toBeCloseTo(50, 9);
	});

	it('reads inches as happily as millimetres', () => {
		const result = resolveViewport(svg({ width: '2in', height: '1in', viewBox: '0 0 200 100' }));
		expect(result.physical.width).toBeCloseTo(50.8, 9);
		expect(result.scaleX).toBeCloseTo(50.8 / 200, 9);
	});
});


describe('aspect ratio mismatch', () => {

	it('scales uniformly and centres, per the default preserveAspectRatio', () => {
		// 200x100 of content into a 100x100mm viewport: uniform 0.5, centred in y
		const result = resolveViewport(svg({ width: '100mm', height: '100mm', viewBox: '0 0 200 100' }));

		expect(result.scaleX).toBeCloseTo(0.5, 9);
		expect(result.scaleY).toBeCloseTo(0.5, 9);

		// content occupies y 25..75, leaving equal margins
		expect(at(result, [0, 0])[1]).toBeCloseTo(75, 9);
		expect(at(result, [200, 100])[1]).toBeCloseTo(25, 9);
	});

	it('stretches independently when told not to preserve the ratio', () => {
		const result = resolveViewport(svg({
			width: '100mm', height: '100mm', viewBox: '0 0 200 100', preserveAspectRatio: 'none',
		}));

		expect(result.scaleX).toBeCloseTo(0.5, 9);
		expect(result.scaleY).toBeCloseTo(1, 9);
		expect(at(result, [0, 0])[1]).toBeCloseTo(100, 9);
	});

	it('aligns to a corner when asked', () => {
		const result = resolveViewport(svg({
			width: '100mm', height: '100mm', viewBox: '0 0 200 100', preserveAspectRatio: 'xMinYMin meet',
		}));

		// no leading margin in y, so the content sits against the top
		expect(at(result, [0, 0])[1]).toBeCloseTo(100, 9);
	});
});


describe('incomplete documents', () => {

	it('falls back to 96dpi for a viewBox with no size, and says so', () => {
		const result = resolveViewport(svg({ viewBox: '0 0 96 96' }));

		expect(result.source).toBe('viewBox-only');
		expect(result.physical.width).toBeCloseTo(25.4, 9);
		expect(result.warnings.join(' ')).toMatch(/CSS pixels/i);
	});

	it('handles a size with no viewBox, where user units are pixels', () => {
		const result = resolveViewport(svg({ width: '25.4mm', height: '25.4mm' }));

		expect(result.source).toBe('width-height-only');
		expect(result.scaleX).toBeCloseTo(MM_PER_PX, 12);
		expect(at(result, [96, 0])[0]).toBeCloseTo(25.4, 9);
	});

	it('warns loudly when there is nothing to go on', () => {
		const result = resolveViewport(svg({}));

		expect(result.source).toBe('assumed');
		expect(result.viewBox).toBeNull();
		expect(result.warnings.join(' ')).toMatch(/guess/i);
	});

	it('warns about a relative unit rather than silently ignoring it', () => {
		const result = resolveViewport(svg({ width: '100%', height: '100%', viewBox: '0 0 10 10' }));
		expect(result.warnings.join(' ')).toMatch(/relative unit/i);
		expect(result.source).toBe('viewBox-only');
	});

	it('pins the CSS pixel constant', () => {
		expect(CSS_PX_PER_INCH).toBe(96);
	});
});
