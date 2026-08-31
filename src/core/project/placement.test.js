/**
 * @file placement.test.js
 * @description Tests for where a shape sits.
 *
 * Measured against the GEOMETRY wherever possible — "a 60mm square moved 10mm
 * right now spans 30 to 90" rather than "the matrix has a 10 in slot four".
 * Matrix arithmetic that is wrong in a way that still composes will pass the
 * second sort of test and cut the part in the wrong place.
 */

import { describe, it, expect } from 'vitest';

import { NodeType, FolderRole, createNode } from './nodes.js';
import { createProject } from './document.js';
import { folderOf } from './tree.js';
import { prepareSvgImport } from './import.js';
import { generateJobToolpath } from './toolpaths.js';
import {
	IDENTITY, compose, apply, isIdentity, localMatrix, localBounds, centreOf,
	matrixFor, svgTransform, transformBounds,
} from './placement.js';

/** Deterministic ids. */
const counter = () => { let k = 0; return () => `n${(k += 1)}`; };

/** A 60 x 40 rectangle from (20,20), in a drawing with a real size. */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="200mm"'
	+ ' viewBox="0 0 200 200"><rect id="plate" x="20" y="20" width="60" height="40"/></svg>';


/**
 * A project with that rectangle imported.
 *
 * @param {Object} [placement] - fields for the path node
 * @param {Object} [docPlacement] - fields for the drawing it sits in
 * @returns {Object} `{ project, pathId, docId }`
 */
function fixture(placement = {}, docPlacement = {}) {

	const newId = counter();
	const project = createProject({ newId });
	const { document } = project;

	const prepared = prepareSvgImport(SVG, { filename: 'a.svg', newId });
	Object.assign(project.geometry, prepared.geometry);
	project.sources[prepared.source] = SVG;

	for (const node of prepared.nodes)
		document.nodes[node.id] = node;

	folderOf(document, FolderRole.SVGS).children.push(prepared.doc.id);

	const path = prepared.nodes.find((node) => node.type === NodeType.SVG_PATH);

	Object.assign(path, placement);
	Object.assign(prepared.doc, docPlacement);

	return { project, pathId: path.id, docId: prepared.doc.id };
}

/** The bounds of a path node after placement. */
const placed = (f, id) =>
	transformBounds(localBounds(f.project, id ?? f.pathId), matrixFor(f.project, id ?? f.pathId));

/** Width and height of a box, rounded so floating point does not shout. */
const size = (box) => [
	Number((box.maxX - box.minX).toFixed(6)), Number((box.maxY - box.minY).toFixed(6))];


describe('a shape nobody has moved', () => {

	it('has the identity, and no transform attribute at all', () => {
		const f = fixture();
		expect(isIdentity(matrixFor(f.project, f.pathId))).toBe(true);
		expect(svgTransform(matrixFor(f.project, f.pathId))).toBe('');
	});

	it('is left exactly as imported', () => {
		const f = fixture();
		expect(size(placed(f))).toEqual([60, 40]);
	});
});


describe('moving one', () => {

	it('translates by exactly the offset asked for', () => {
		const f = fixture({ offset: { x: 10, y: -5 } });
		const box = placed(f);
		const plain = placed(fixture());

		expect(box.minX - plain.minX).toBeCloseTo(10, 9);
		expect(box.minY - plain.minY).toBeCloseTo(-5, 9);
		expect(size(box)).toEqual([60, 40]);
	});

	it('rotates about its OWN centre, not about the drawing origin', () => {

		// The distinguishing case, and the reason `centreOf` exists. A quarter
		// turn about the centre swaps width and height and leaves the centre
		// exactly where it was; a quarter turn about the origin sends a shape
		// sitting at x20..80 across the bed.
		const f = fixture({ rotation: Math.PI / 2 });
		const before = centreOf(f.project, f.pathId);
		const box = placed(f);

		expect(size(box)).toEqual([40, 60]);
		expect((box.minX + box.maxX) / 2).toBeCloseTo(before[0], 9);
		expect((box.minY + box.maxY) / 2).toBeCloseTo(before[1], 9);
	});

	it('scales about its own centre too', () => {
		const f = fixture({ scale: { x: 2, y: 2 } });
		const before = centreOf(f.project, f.pathId);
		const box = placed(f);

		expect(size(box)).toEqual([120, 80]);
		expect((box.minX + box.maxX) / 2).toBeCloseTo(before[0], 9);
	});

	it('scales each axis on its own', () => {
		expect(size(placed(fixture({ scale: { x: 2, y: 0.5 } })))).toEqual([120, 20]);
	});

	it('scales BEFORE it rotates, so a stretched shape turns as one piece', () => {

		// Order matters and is visible: scale-then-rotate turns a 120x40 shape a
		// quarter turn into 40x120. Rotate-then-scale would stretch the already
		// turned shape and give 80x60 instead.
		const f = fixture({ scale: { x: 2, y: 1 }, rotation: Math.PI / 2 });
		expect(size(placed(f))).toEqual([40, 120]);
	});
});


describe('a shape inside a drawing that has itself been moved', () => {

	it('gets both, outermost first', () => {
		const f = fixture({ offset: { x: 10, y: 0 } }, { offset: { x: 100, y: 0 } });
		const plain = placed(fixture());
		expect(placed(f).minX - plain.minX).toBeCloseTo(110, 9);
	});

	it('turns with the drawing about the DRAWING’s centre', () => {

		// A path turning about its own centre inside a drawing turning about the
		// drawing's centre is not the same as either alone. With one path they
		// coincide, so the fixture cannot show it — what it CAN show is that the
		// two compose rather than one winning.
		const f = fixture({ rotation: Math.PI / 2 }, { rotation: Math.PI / 2 });
		expect(size(placed(f))).toEqual([60, 40]);
	});

	it('leaves the drawing’s own bounds as the union of its paths', () => {
		const f = fixture();
		expect(size(localBounds(f.project, f.docId))).toEqual([60, 40]);
	});
});


describe('the cut follows the shape, which is the whole point', () => {

	/**
	 * The toolpath bounds for a job over the fixture's path.
	 *
	 * @param {Object} f - the fixture
	 * @returns {Object} the bounds
	 */
	function cutBounds(f) {

		const { document } = f.project;

		const tool = createNode(NodeType.TOOL, { name: 'Bit' }, { newId: () => 'tool' });
		const job = createNode(NodeType.JOB, {
			name: 'Cut', paths: [f.pathId], operation: 'outside', cutDepth: 1,
		}, { newId: () => 'job' });

		tool.children = [job.id];
		document.nodes[tool.id] = tool;
		document.nodes[job.id] = job;
		folderOf(document, FolderRole.JOBS).children.push(tool.id);

		const points = generateJobToolpath(f.project, job.id).paths.flatMap((p) => p.points);
		const xs = points.map((p) => p[0]);
		const ys = points.map((p) => p[1]);

		return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
	}

	it('cuts a moved shape where the shape now is', () => {

		// The failure this guards against is the worst kind: the view shows the
		// part in its new place and the machine cuts it in the old one.
		const plain = cutBounds(fixture());
		const moved = cutBounds(fixture({ offset: { x: 25, y: 15 } }));

		expect(moved.minX - plain.minX).toBeCloseTo(25, 6);
		expect(moved.minY - plain.minY).toBeCloseTo(15, 6);
	});

	it('cuts a scaled shape at its new size, kerf and all', () => {

		// 60 x 40 doubled is 120 x 80; cut outside with a 3.175mm bit the toolpath
		// is 123.175 across. The kerf does NOT scale with the shape — it is the
		// cutter, and the cutter is the size it is.
		const box = cutBounds(fixture({ scale: { x: 2, y: 2 } }));
		expect(box.maxX - box.minX).toBeCloseTo(123.175, 2);
		expect(box.maxY - box.minY).toBeCloseTo(83.175, 2);
	});

	it('cuts a rotated shape turned round', () => {
		const box = cutBounds(fixture({ rotation: Math.PI / 2 }));
		expect(box.maxX - box.minX).toBeCloseTo(43.175, 2);
		expect(box.maxY - box.minY).toBeCloseTo(63.175, 2);
	});
});


describe('the matrix helpers', () => {

	it('composes outer after inner', () => {
		const move = [1, 0, 0, 1, 10, 0];
		const grow = [2, 0, 0, 2, 0, 0];

		// move applied AFTER grow: (5,0) -> (10,0) -> (20,0)
		expect(apply(compose(move, grow), [5, 0])).toEqual([20, 0]);

		// grow applied after move: (5,0) -> (15,0) -> (30,0)
		expect(apply(compose(grow, move), [5, 0])).toEqual([30, 0]);
	});

	it('leaves a point alone under the identity', () => {
		expect(apply(IDENTITY, [3, 7])).toEqual([3, 7]);
	});

	it('treats a shape with no fields as unmoved', () => {
		expect(isIdentity(localMatrix({}, [50, 50]))).toBe(true);
		expect(isIdentity(localMatrix(undefined, undefined))).toBe(true);
	});

	it('takes all four corners of a rotated box, not two', () => {

		// Two opposite corners of a box turned 45 degrees give a box that is too
		// small at every angle but a right one.
		const turned = localMatrix({ rotation: Math.PI / 4 }, [0, 0]);
		const box = transformBounds({ minX: -10, minY: -10, maxX: 10, maxY: 10 }, turned);

		expect(box.maxX - box.minX).toBeCloseTo(20 * Math.SQRT2, 9);
	});

	it('is null for nothing, rather than a box around the origin', () => {
		expect(transformBounds(null, IDENTITY)).toBe(null);
	});
});
