import { describe, it, expect } from 'vitest';
import { importSvgDocument, parseSvgRoot, countSubPathKinds } from './document.js';
import { flattenSubPath } from '../path/flatten.js';

/** Wraps body markup in a root svg of a known physical size. */
const doc = (body, attrs = 'width="100mm" height="100mm" viewBox="0 0 100 100"') =>
	`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

/** All points of a shape, flattened, in millimetres. */
const pointsOf = (shape, tolerance = 0.01) =>
	shape.subPaths.flatMap((sp) => flattenSubPath(sp, { tolerance }).points);

/** Bounds of a shape in millimetres. */
const boundsOf = (shape) => {
	const pts = pointsOf(shape);
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
};


describe('parsing failures are loud', () => {

	it('throws on malformed XML', () => {
		expect(() => parseSvgRoot('<svg><rect width="1"></svg>')).toThrow(/parse/i);
		expect(() => parseSvgRoot('not xml at all')).toThrow(/parse/i);
	});

	it('throws on an empty document', () => {
		expect(() => parseSvgRoot('')).toThrow(/empty/i);
		expect(() => parseSvgRoot(null)).toThrow(/empty/i);
	});

	it('throws when the root is not an svg', () => {
		expect(() => parseSvgRoot('<html><body/></html>')).toThrow(/<svg>/i);
	});
});


describe('geometry lands in millimetres, y-up', () => {

	it('places a rect at its true physical position', () => {
		// viewBox 0..100 across 100mm, so user units are millimetres directly
		const { shapes } = importSvgDocument(doc('<rect x="10" y="20" width="30" height="40"/>'));

		expect(shapes).toHaveLength(1);

		const b = boundsOf(shapes[0]);
		expect(b.minX).toBeCloseTo(10, 6);
		expect(b.maxX).toBeCloseTo(40, 6);

		// SVG y=20..60 measured from the top flips to 40..80 from the bottom
		expect(b.minY).toBeCloseTo(40, 6);
		expect(b.maxY).toBeCloseTo(80, 6);
	});

	it('scales by the viewBox rather than guessing a dpi', () => {
		// 200 user units across 100mm: everything is half size
		const { shapes } = importSvgDocument(
			doc('<rect x="0" y="0" width="100" height="100"/>', 'width="100mm" height="100mm" viewBox="0 0 200 200"'),
		);

		const b = boundsOf(shapes[0]);
		expect(b.maxX - b.minX).toBeCloseTo(50, 6);
	});

	it('composes transforms down through nested groups', () => {
		const { shapes } = importSvgDocument(doc(
			'<g transform="translate(10,10)"><g transform="scale(2)">'
			+ '<rect x="0" y="0" width="10" height="10"/></g></g>',
		));

		const b = boundsOf(shapes[0]);
		expect(b.minX).toBeCloseTo(10, 6);
		expect(b.maxX).toBeCloseTo(30, 6);
	});

	it('skips an element whose transform it cannot parse, and says which', () => {
		const { shapes, warnings } = importSvgDocument(
			doc('<rect id="bad" transform="wobble(3)" width="10" height="10"/>'),
		);

		expect(shapes).toHaveLength(0);
		expect(warnings.join(' ')).toMatch(/bad/);
	});
});


describe('the primitives jscut rejects', () => {

	it('imports polyline, polygon, circle, ellipse and line', () => {
		const { shapes, warnings } = importSvgDocument(doc(`
			<polyline points="0,0 10,10 20,0"/>
			<polygon points="30,0 40,10 50,0"/>
			<circle cx="60" cy="10" r="5"/>
			<ellipse cx="80" cy="10" rx="8" ry="4"/>
			<line x1="0" y1="50" x2="20" y2="50"/>
			<path d="M0 80 L10 90"/>
		`));

		expect(shapes).toHaveLength(6);
		expect(warnings).toHaveLength(0);
		expect(shapes.map((s) => s.tag).sort())
			.toEqual(['circle', 'ellipse', 'line', 'path', 'polygon', 'polyline']);
	});

	it('preserves the open/closed distinction across a document', () => {
		const { shapes } = importSvgDocument(doc(`
			<polyline points="0,0 10,10 20,0"/>
			<polygon points="30,0 40,10 50,0"/>
			<line x1="0" y1="50" x2="20" y2="50"/>
		`));

		expect(countSubPathKinds(shapes)).toEqual({ open: 2, closed: 1 });
	});
});


describe('use and defs', () => {

	it('does not draw defs content in place', () => {
		const { shapes } = importSvgDocument(doc('<defs><rect id="r" width="10" height="10"/></defs>'));
		expect(shapes).toHaveLength(0);
	});

	it('expands a use reference, honouring its x/y', () => {
		const { shapes } = importSvgDocument(doc(
			'<defs><rect id="r" x="0" y="0" width="10" height="10"/></defs>'
			+ '<use href="#r" x="50" y="0"/>',
		));

		expect(shapes).toHaveLength(1);
		const b = boundsOf(shapes[0]);
		expect(b.minX).toBeCloseTo(50, 6);
		expect(b.maxX).toBeCloseTo(60, 6);
	});

	it('supports the legacy xlink:href spelling', () => {
		const { shapes } = importSvgDocument(
			`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
			      width="100mm" height="100mm" viewBox="0 0 100 100">
			   <defs><rect id="r" width="10" height="10"/></defs>
			   <use xlink:href="#r" x="20" y="0"/>
			 </svg>`,
		);
		expect(shapes).toHaveLength(1);
	});

	it('reports a dangling reference instead of dropping it in silence', () => {
		const { shapes, warnings } = importSvgDocument(doc('<use href="#nope"/>'));
		expect(shapes).toHaveLength(0);
		expect(warnings.join(' ')).toMatch(/missing id "nope"/);
	});

	it('refuses to loop forever on a reference cycle', () => {
		const { warnings } = importSvgDocument(doc(
			'<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g>',
		));
		expect(warnings.join(' ')).toMatch(/cycle/i);
	});
});


describe('stylesheets — the Illustrator export shape', () => {

	const illustrator = doc(`
		<style type="text/css">
			.st0 { fill:none; stroke:#000000; }
			.st1 { display:none; }
			.st2 { fill-rule:evenodd; }
		</style>
		<rect class="st0" id="visible" x="0" y="0" width="10" height="10"/>
		<rect class="st1" id="hidden"  x="20" y="0" width="10" height="10"/>
		<path class="st2" id="evenodd" d="M40 0 L50 0 L50 10 Z"/>
	`);

	it('honours display:none from a class, which is a correctness issue not a cosmetic one', () => {
		const { shapes } = importSvgDocument(illustrator);
		expect(shapes.map((s) => s.label)).not.toContain('hidden');
		expect(shapes).toHaveLength(2);
	});

	it('reads fill-rule out of a stylesheet', () => {
		const { shapes } = importSvgDocument(illustrator);
		const evenodd = shapes.find((s) => s.label === 'evenodd');
		expect(evenodd.fillRule).toBe('evenodd');
	});

	it('carries fill and stroke through for display purposes', () => {
		const { shapes } = importSvgDocument(illustrator);
		const visible = shapes.find((s) => s.label === 'visible');
		expect(visible.style.stroke).toBe('#000000');
		expect(visible.style.fill).toBe('none');
	});

	it('lets a style attribute beat a stylesheet rule', () => {
		const { shapes } = importSvgDocument(doc(
			'<style>.a{fill-rule:evenodd}</style>'
			+ '<path class="a" style="fill-rule:nonzero" d="M0 0 L10 0 L10 10 Z"/>',
		));
		expect(shapes[0].fillRule).toBe('nonzero');
	});

	it('inherits presentation properties down the tree', () => {
		const { shapes } = importSvgDocument(doc(
			'<g fill-rule="evenodd"><path d="M0 0 L10 0 L10 10 Z"/></g>',
		));
		expect(shapes[0].fillRule).toBe('evenodd');
	});

	it('warns about selectors it cannot honour rather than half-applying them', () => {
		const { warnings } = importSvgDocument(doc(
			'<style>g > .a:hover { fill:red }</style><rect width="1" height="1"/>',
		));
		expect(warnings.join(' ')).toMatch(/unsupported css selector/i);
	});

	it('respects a plain display:none attribute too', () => {
		const { shapes } = importSvgDocument(doc('<rect display="none" width="10" height="10"/>'));
		expect(shapes).toHaveLength(0);
	});
});


describe('what it cannot do, it says out loud', () => {

	it('names text as unsupported and suggests the fix', () => {
		const { shapes, warnings } = importSvgDocument(doc('<text id="t" x="0" y="0">hello</text>'));
		expect(shapes).toHaveLength(0);
		expect(warnings.join(' ')).toMatch(/text/i);
		expect(warnings.join(' ')).toMatch(/convert it to a path/i);
	});

	it('reports images and foreignObject', () => {
		const { warnings } = importSvgDocument(doc('<image href="x.png"/><foreignObject/>'));
		expect(warnings.filter((w) => /not supported/i.test(w))).toHaveLength(2);
	});

	it('warns that a nested svg is flattened into a group', () => {
		// jscut returns null here with no message at all, so the shape simply
		// vanishes from the cut with nothing to explain it
		const { shapes, warnings } = importSvgDocument(doc(
			'<svg x="0" y="0" width="50" height="50"><rect width="10" height="10"/></svg>',
		));
		expect(shapes).toHaveLength(1);
		expect(warnings.join(' ')).toMatch(/nested <svg/i);
	});

	it('ignores metadata and editor cruft without complaining', () => {
		const { shapes, warnings } = importSvgDocument(
			`<svg xmlns="http://www.w3.org/2000/svg"
			      xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
			      xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
			      width="100mm" height="100mm" viewBox="0 0 100 100">
			   <title>a drawing</title><desc>notes</desc>
			   <metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></metadata>
			   <sodipodi:namedview id="base"><inkscape:grid type="xygrid"/></sodipodi:namedview>
			   <g inkscape:label="Layer 1" inkscape:groupmode="layer">
			     <rect x="0" y="0" width="10" height="10"/>
			   </g>
			 </svg>`,
		);

		expect(shapes).toHaveLength(1);
		expect(warnings).toHaveLength(0);
	});
});


describe('labels', () => {

	it('prefers the author id, and numbers the rest', () => {
		const { shapes } = importSvgDocument(doc(
			'<rect id="plate" width="1" height="1"/><rect width="1" height="1"/><rect width="1" height="1"/>',
		));
		expect(shapes.map((s) => s.label)).toEqual(['plate', 'rect 1', 'rect 2']);
	});
});
