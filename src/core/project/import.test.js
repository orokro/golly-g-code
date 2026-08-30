import { describe, it, expect } from 'vitest';

import { NodeType, FolderRole, createNode } from './nodes.js';
import { createProject } from './document.js';
import { folderOf, childrenOf, validateTree } from './tree.js';
import { createHistory } from './history.js';
import { nodeDriver } from './snapshot.js';
import { addSubtree, removeNode } from './commands.js';
import { prepareSvgImport, uniqueName, summarise } from './import.js';

/** Deterministic ids. */
const counter = (prefix = 'n') => { let k = 0; return () => `${prefix}${(k += 1)}`; };

/** A drawing with a closed square, an open line, and a shape with a hole. */
const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
	<rect id="plate" x="10" y="10" width="30" height="30"/>
	<path id="skyline" d="M50 10 L60 20 L70 10"/>
	<path id="washer" d="M10 60 h30 v30 h-30 Z M18 68 h14 v14 h-14 Z"/>
	<path id="mixed" d="M60 60 h20 v20 h-20 Z M60 90 L80 95"/>
</svg>`;


describe('reading a drawing into nodes', () => {

	it('makes one document node with a path node per shape', () => {
		const prepared = prepareSvgImport(SVG, { filename: 'parts.svg', newId: counter() });

		expect(prepared.doc.type).toBe(NodeType.SVG_DOC);
		expect(prepared.doc.name).toBe('parts.svg');
		expect(prepared.nodes.filter((node) => node.type === NodeType.SVG_PATH).map((n) => n.name))
			.toEqual(['plate', 'skyline', 'washer', 'mixed']);
	});

	it('takes the author’s own ids as names, because they are what they called them', () => {
		const prepared = prepareSvgImport(SVG, { newId: counter() });

		expect(prepared.nodes[1].name).toBe('plate');
	});

	it('keeps a shape with a hole as ONE node', () => {
		// split in two, "inside" on the outer contour cuts the hole away and
		// "inside" on the inner one means nothing -- which contour is a hole is a
		// property of the set, not of either one alone
		const prepared = prepareSvgImport(SVG, { newId: counter() });
		const washer = prepared.nodes.find((node) => node.name === 'washer');

		expect(prepared.geometry[washer.geometry].subPaths).toHaveLength(2);
	});

	it('calls a shape closed only when EVERY subpath of it is', () => {
		// `mixed` is the case that matters and the one the first version of this
		// test did not have: a square and a loose line in the same shape. Nothing
		// distinguishes "every subpath is closed" from "any subpath is closed"
		// until one shape disagrees with itself, and a shape that is not entirely
		// closed cannot be treated as an area however many of its parts are
		const prepared = prepareSvgImport(SVG, { newId: counter() });
		const closed = Object.fromEntries(prepared.nodes
			.filter((node) => node.type === NodeType.SVG_PATH)
			.map((node) => [node.name, node.closed]));

		expect(closed).toEqual({ plate: true, skyline: false, washer: true, mixed: false });
	});

	it('keys geometry by the node that owns it', () => {
		// an orphaned entry is then recognisable when reading a file by hand
		const prepared = prepareSvgImport(SVG, { newId: counter() });

		for (const node of prepared.nodes.filter((n) => n.type === NodeType.SVG_PATH))
			expect(prepared.geometry[node.geometry], node.name).toBeDefined();

		expect(Object.keys(prepared.geometry)).toHaveLength(4);
	});

	it('converts to millimetres on the way in, as the core’s one rule says', () => {
		// the document is 100mm across a 100-unit viewBox, so a 30-unit square is
		// 30mm and the numbers are readable as themselves
		const prepared = prepareSvgImport(SVG, { newId: counter() });
		const plate = prepared.nodes.find((node) => node.name === 'plate');
		const xs = prepared.geometry[plate.geometry].subPaths[0].segments.map((s) => s.to[0]);

		expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(30, 6);
	});

	it('passes the importer’s warnings along rather than swallowing them', () => {
		const withText = SVG.replace('</svg>', '<text x="0" y="0">hello</text></svg>');

		expect(prepareSvgImport(withText, { newId: counter() }).warnings.join(' ')).toMatch(/text/i);
	});

	it('throws on something that is not an SVG at all', () => {
		expect(() => prepareSvgImport('not xml', { newId: counter() })).toThrow();
	});

	it('summarises what came in, open paths and all', () => {
		const prepared = prepareSvgImport(SVG, { newId: counter() });

		expect(summarise(prepared)).toEqual({ total: 4, closed: 2, open: 2 });
	});
});


describe('not overwriting an original', () => {

	it('finds a free name when the same file is imported twice', () => {
		// the number goes before the extension, so the file is still a .svg to
		// everything that cares -- including whatever opens it later
		expect(uniqueName('logo.svg', {})).toBe('logo.svg');
		expect(uniqueName('logo.svg', { 'logo.svg': 1 })).toBe('logo (2).svg');
		expect(uniqueName('logo.svg', { 'logo.svg': 1, 'logo (2).svg': 1 })).toBe('logo (3).svg');
	});

	it('copes with a name that has no extension', () => {
		expect(uniqueName('drawing', { drawing: 1 })).toBe('drawing (2)');
	});

	it('is used by the import, so the first original survives the second import', () => {
		// the whole point of keeping originals is that they are still there
		const first = prepareSvgImport(SVG, { filename: 'parts.svg', newId: counter('a') });
		const second = prepareSvgImport(SVG, {
			filename: 'parts.svg',
			newId: counter('b'),
			existingSources: { [first.source]: SVG },
		});

		expect(first.source).toBe('parts.svg');
		expect(second.source).toBe('parts (2).svg');

		// the NODE keeps the name the user recognises; only the stored original
		// gets disambiguated, because that is the thing that would collide
		expect(second.doc.name).toBe('parts.svg');
	});
});


describe('adding it to a document', () => {

	/**
	 * A project with a history that checks every command's touches.
	 *
	 * @returns {Object} `{ project, document, h }`
	 */
	const fixture = () => {
		const project = createProject({ newId: counter() });
		return { project, document: project.document, h: createHistory({ driver: nodeDriver, verify: true }) };
	};

	it('lands as ONE undo entry, not one per path', () => {
		// a dozen entries to undo an import that was one click is not a history
		const { project, document, h } = fixture();
		const prepared = prepareSvgImport(SVG, { filename: 'parts.svg', newId: counter('s') });
		Object.assign(project.geometry, prepared.geometry);

		h.dispatch(document, addSubtree(document, folderOf(document, FolderRole.SVGS).id,
			prepared.nodes, { label: 'Import parts.svg' }));

		expect(h.depth().past).toBe(1);
		expect(h.undoLabel()).toBe('Import parts.svg');
		expect(childrenOf(document, prepared.doc.id)).toHaveLength(4);
		expect(validateTree(document)).toEqual([]);
	});

	it('undoes the whole import in one go', () => {
		const { project, document, h } = fixture();
		const prepared = prepareSvgImport(SVG, { newId: counter('s') });
		Object.assign(project.geometry, prepared.geometry);

		h.dispatch(document, addSubtree(document, folderOf(document, FolderRole.SVGS).id, prepared.nodes));
		h.undo(document);

		expect(document.nodes[prepared.doc.id]).toBeUndefined();
		expect(childrenOf(document, folderOf(document, FolderRole.SVGS).id)).toEqual([]);
		expect(validateTree(document)).toEqual([]);
	});

	it('leaves the geometry behind on undo, which is what the redo wants', () => {
		const { project, document, h } = fixture();
		const prepared = prepareSvgImport(SVG, { newId: counter('s') });
		Object.assign(project.geometry, prepared.geometry);

		h.dispatch(document, addSubtree(document, folderOf(document, FolderRole.SVGS).id, prepared.nodes));
		h.undo(document);

		expect(Object.keys(project.geometry)).toHaveLength(4);

		h.redo(document);
		const path = childrenOf(document, prepared.doc.id)[0];
		expect(project.geometry[path.geometry]).toBeDefined();
	});

	it('adds a Tool with a Job already in it, for the first job in a project', () => {
		const { document, h } = fixture();
		const newId = counter('t');
		const tool = createNode(NodeType.TOOL, { name: '1/8 flat' }, { newId });
		const job = createNode(NodeType.JOB, { name: 'Cut' }, { newId });
		tool.children = [job.id];

		h.dispatch(document, addSubtree(document, folderOf(document, FolderRole.JOBS).id,
			[tool, job], { label: 'Add job' }));

		expect(h.depth().past).toBe(1);
		expect(childrenOf(document, tool.id).map((n) => n.name)).toEqual(['Cut']);
		expect(validateTree(document)).toEqual([]);
	});

	it('selects what it added, so undo restores the selection you had', () => {
		const { document, h } = fixture();
		const prepared = prepareSvgImport(SVG, { newId: counter('s') });
		const before = document.selection.active;

		h.dispatch(document, addSubtree(document, folderOf(document, FolderRole.SVGS).id, prepared.nodes));
		expect(document.selection.active).toBe(prepared.doc.id);

		h.undo(document);
		expect(document.selection.active).toBe(before);
	});

	it('refuses an empty subtree or an unknown parent', () => {
		const { document } = fixture();

		expect(() => addSubtree(document, document.root, [])).toThrow(/at least one node/);
		expect(() => addSubtree(document, 'ghost', [createNode(NodeType.TOOL, {}, { newId: () => 'x' })]))
			.toThrow(/No node "ghost"/);
	});

	it('takes a deleted import back out cleanly, geometry references and all', () => {
		const { project, document, h } = fixture();
		const prepared = prepareSvgImport(SVG, { newId: counter('s') });
		Object.assign(project.geometry, prepared.geometry);

		h.dispatch(document, addSubtree(document, folderOf(document, FolderRole.SVGS).id, prepared.nodes));
		h.dispatch(document, removeNode(document, prepared.doc.id));

		expect(validateTree(document)).toEqual([]);

		h.undo(document);
		expect(childrenOf(document, prepared.doc.id)).toHaveLength(4);
	});
});
