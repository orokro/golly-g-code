import { describe, it, expect } from 'vitest';

import {
	NodeType, FolderRole, Kind, Quantity, FIELDS, JobOperation,
	ALLOWED_CHILDREN, createNode, fieldsOf, fieldSpec,
} from './nodes.js';
import { createProject, DOCUMENT_VERSION, referenced, pruneProject } from './document.js';
import {
	parentOf, childrenOf, ancestorsOf, ancestorOfType,
	isVisible, isLocked, folderOf, cuttingOrder, validateTree,
} from './tree.js';
import { Source, resolveField, resolveNode, resolvedValues, overridesOf, dependentsOf } from './inherit.js';
import { validateNode, validateDocument, validateValue } from './schema.js';

/** Deterministic ids, so a failure names something findable. */
const counter = () => { let n = 0; return () => `n${(n += 1)}`; };

/**
 * A project with one tool, two jobs, one tab and an SVG with two paths.
 *
 * @returns {Object} `{ project, document, id }` where `id` looks nodes up by name
 */
function fixture() {

	const newId = counter();
	const project = createProject({ name: 'Test', newId });
	const document = project.document;
	const put = (parentId, node) => {
		document.nodes[node.id] = node;
		document.nodes[parentId].children.push(node.id);
		return node;
	};

	const jobs = folderOf(document, FolderRole.JOBS);
	const svgs = folderOf(document, FolderRole.SVGS);

	const doc = put(svgs.id, createNode(NodeType.SVG_DOC, { name: 'skyline.svg' }, { newId }));
	const open = put(doc.id, createNode(NodeType.SVG_PATH, { name: 'skyline', closed: false }, { newId }));
	const closed = put(doc.id, createNode(NodeType.SVG_PATH, { name: 'plate', closed: true }, { newId }));

	const tool = put(jobs.id, createNode(NodeType.TOOL, { name: '1/8 flat' }, { newId }));
	const a = put(tool.id, createNode(NodeType.JOB, { name: 'Skyline', paths: [open.id] }, { newId }));
	const b = put(tool.id, createNode(NodeType.JOB, { name: 'Plate', paths: [closed.id] }, { newId }));
	const tab = put(a.id, createNode(NodeType.TAB, { name: 'Tab 1', position: 20 }, { newId }));

	const named = { jobs, svgs, doc, open, closed, tool, a, b, tab, root: document.nodes[document.root] };

	return { project, document, n: named };
}


describe('the field table', () => {

	// These are the checks that cannot be written by restating the table: each
	// one holds two parts of it against each other.

	it('gives every default a value its own schema accepts', () => {
		for (const [type, fields] of Object.entries(FIELDS))
			for (const [field, spec] of Object.entries(fields))
				expect(validateValue(type, field, spec.default), `${type}.${field}`).toEqual([]);
	});

	it('never defaults a select to something not in its options', () => {
		for (const [type, fields] of Object.entries(FIELDS))
			for (const [field, spec] of Object.entries(fields))
				if (spec.kind === Kind.SELECT)
					expect(spec.options, `${type}.${field}`).toContain(spec.default);
	});

	it('only inherits from a field that exists on the type it names', () => {
		for (const [type, fields] of Object.entries(FIELDS))
			for (const [field, spec] of Object.entries(fields)) {
				if (spec.inherit === undefined)
					continue;
				const target = fieldSpec(spec.inherit.from, spec.inherit.field);
				expect(target, `${type}.${field} inherits from ${spec.inherit.from}.${spec.inherit.field}`)
					.not.toBeNull();
			}
	});

	it('never inherits a physical property, or one of a different kind', () => {
		for (const [type, fields] of Object.entries(FIELDS))
			for (const [field, spec] of Object.entries(fields)) {
				if (spec.inherit === undefined)
					continue;
				const target = fieldSpec(spec.inherit.from, spec.inherit.field);
				// a two-flute cutter has two flutes; that is not a preference
				expect(target.physical, `${type}.${field}`).not.toBe(true);
				expect(target.kind, `${type}.${field} kind`).toBe(spec.kind);
			}
	});

	it('only inherits from an ancestor type, never a sibling or a descendant', () => {
		/**
		 * Whether `from` can appear above `type` in a valid tree.
		 *
		 * @param {String} from - the ancestor type
		 * @param {String} type - the descendant type
		 * @returns {Boolean} true when a path exists
		 */
		const reaches = (from, type) => {
			const seen = new Set();
			const walk = (at) => at === type
				|| (!seen.has(at) && (seen.add(at), ALLOWED_CHILDREN[at].some(walk)));
			return walk(from);
		};

		for (const [type, fields] of Object.entries(FIELDS))
			for (const [field, spec] of Object.entries(fields))
				if (spec.inherit !== undefined)
					expect(reaches(spec.inherit.from, type), `${type}.${field}`).toBe(true);
	});

	it('describes every field, because the Inspector renders these', () => {
		for (const [type, fields] of Object.entries(FIELDS))
			for (const [field, spec] of Object.entries(fields)) {
				expect(spec.label, `${type}.${field} label`).toBeTruthy();
				expect(spec.desc, `${type}.${field} desc`).toBeTruthy();
				expect(Object.values(Kind), `${type}.${field} kind`).toContain(spec.kind);
				expect(Object.values(Quantity), `${type}.${field} quantity`).toContain(spec.quantity);
			}
	});

	it('gives an operation for every closed and open mode the core implements', () => {
		// the union in JobOperation is the thing that could silently lose a member
		expect(Object.values(JobOperation).sort())
			.toEqual(['center', 'engrave', 'heading', 'inside', 'normal', 'outside', 'pocket']);
	});
});


describe('creating nodes', () => {

	it('fills in the defaults', () => {
		const tool = createNode(NodeType.TOOL, {}, { newId: () => 'x' });

		expect(tool).toMatchObject({ id: 'x', type: NodeType.TOOL, diameter: 3.175, flutes: 2, visible: true });
	});

	it('leaves inheritable fields ABSENT, which is what inherited means', () => {
		const job = createNode(NodeType.JOB, {}, { newId: () => 'x' });

		expect('passDepth' in job).toBe(false);
		expect('cutFeed' in job).toBe(false);
		// and does fill in the ones that are the job's own business
		expect(job.cutDepth).toBe(1);
	});

	it('names itself after its type rather than being blank', () => {
		expect(createNode(NodeType.JOB, {}, { newId: () => 'x' }).name).toBe('Job');
	});

	it('gives children only to types that may have them', () => {
		const make = (type) => createNode(type, {}, { newId: () => 'x' });

		expect(make(NodeType.TOOL).children).toEqual([]);
		expect('children' in make(NodeType.TAB)).toBe(false);
	});

	it('refuses a field the type does not have, rather than storing it', () => {
		expect(() => createNode(NodeType.TAB, { diameter: 3 }, { newId: () => 'x' }))
			.toThrow(/Tab has no field "diameter"/);
	});

	it('never lets two nodes share a default object', () => {
		const one = createNode(NodeType.PROJECT, {}, { newId: () => 'a' });
		const two = createNode(NodeType.PROJECT, {}, { newId: () => 'b' });

		one.workZero.x = 99;
		expect(two.workZero.x).toBe(0);
	});
});


describe('a new project', () => {

	it('is a project node and its three folders, and nothing else', () => {
		const { document } = createProject({ newId: counter() });

		expect(Object.keys(document.nodes)).toHaveLength(4);
		expect(childrenOf(document, document.root).map((n) => n.role))
			.toEqual([FolderRole.JOBS, FolderRole.SVGS, FolderRole.REFERENCES]);
	});

	it('carries a format version from the very first one', () => {
		expect(createProject({ newId: counter() }).version).toBe(DOCUMENT_VERSION);
	});

	it('makes no tool, because an empty tool group is a thing to explain', () => {
		const { document } = createProject({ newId: counter() });

		expect(Object.values(document.nodes).some((n) => n.type === NodeType.TOOL)).toBe(false);
	});

	it('is structurally sound, and so is the fixture', () => {
		expect(validateTree(createProject({ newId: counter() }).document)).toEqual([]);
		expect(validateTree(fixture().document)).toEqual([]);
	});

	it('is valid against its own schemas', () => {
		expect(validateDocument(fixture().document)).toEqual([]);
	});
});


describe('reading the shape', () => {

	it('finds a parent without the tree storing one', () => {
		const { document, n } = fixture();

		expect(parentOf(document, n.a.id).id).toBe(n.tool.id);
		expect(parentOf(document, document.root)).toBeNull();
	});

	it('walks up to the tool a job belongs to, and the project above that', () => {
		const { document, n } = fixture();

		expect(ancestorOfType(document, n.tab.id, NodeType.TOOL).id).toBe(n.tool.id);
		expect(ancestorOfType(document, n.tab.id, NodeType.PROJECT).id).toBe(document.root);
		expect(ancestorsOf(document, n.tab.id).map((x) => x.type))
			.toEqual([NodeType.JOB, NodeType.TOOL, NodeType.FOLDER, NodeType.PROJECT]);
	});

	it('reads cutting order straight off the tree, because order IS order', () => {
		const { document, n } = fixture();

		expect(cuttingOrder(document).map((x) => x.job.name)).toEqual(['Skyline', 'Plate']);

		document.nodes[n.tool.id].children.reverse();
		expect(cuttingOrder(document).map((x) => x.job.name)).toEqual(['Plate', 'Skyline']);
	});

	it('inherits hidden and locked downwards without touching the child', () => {
		const { document, n } = fixture();

		document.nodes[n.tool.id].visible = false;

		expect(isVisible(document, n.a.id)).toBe(false);
		// the job's own flag is untouched, so unhiding the tool brings back
		// exactly what was showing before
		expect(document.nodes[n.a.id].visible).toBe(true);

		document.nodes[n.tool.id].visible = true;
		expect(isVisible(document, n.a.id)).toBe(true);

		document.nodes[n.jobs.id].locked = true;
		expect(isLocked(document, n.tab.id)).toBe(true);
	});
});


describe('checking the shape', () => {

	/**
	 * Breaks a fixture and reports what validateTree says.
	 *
	 * @param {Function} damage - does something wrong to the document
	 * @returns {String[]} the issues
	 */
	const after = (damage) => {
		const { document, n } = fixture();
		damage(document, n);
		return validateTree(document);
	};

	it('catches a child that is not there', () => {
		expect(after((d, n) => d.nodes[n.tool.id].children.push('ghost'))[0])
			.toMatch(/lists a child "ghost"/);
	});

	it('catches a node nothing points at, and everything under it', () => {
		// detaching the tool's children strands both jobs AND the tab under one
		// of them -- naming them beats counting them, which I got wrong first
		const { document, n } = fixture();
		document.nodes[n.tool.id].children = [];

		const stranded = validateTree(document)
			.filter((issue) => /not reachable/.test(issue));

		expect(stranded).toHaveLength(3);
		for (const node of [n.a, n.b, n.tab])
			expect(stranded.join('\n'), node.name).toContain(node.id);
	});

	it('catches a job that has escaped its tool', () => {
		expect(after((d, n) => { d.nodes[n.jobs.id].children.push(n.a.id); })[0])
			.toMatch(/may not contain a Job|claimed as a child by 2/);
	});

	it('catches a dangling reference to a deleted path', () => {
		expect(after((d, n) => { d.nodes[n.a.id].paths = ['gone']; })[0])
			.toMatch(/refers to "gone" in paths/);
	});

	it('catches a selection pointing at nothing', () => {
		expect(after((d) => { d.selection.active = 'gone'; })[0])
			.toMatch(/selection refers to "gone"/);
	});

	it('says so plainly when the root is missing', () => {
		expect(after((d) => { delete d.nodes[d.root]; })[0]).toMatch(/root .* is not in the document/);
	});
});


describe('checking the values', () => {

	it('accepts a well-formed node', () => {
		expect(validateNode(createNode(NodeType.TOOL, {}, { newId: () => 'x' }))).toEqual([]);
	});

	it('rejects a number outside the range the Inspector would allow', () => {
		expect(validateValue(NodeType.TOOL, 'stepover', 1.5)[0]).toMatch(/<=1/);
		expect(validateValue(NodeType.TOOL, 'stepover', 0.5)).toEqual([]);
	});

	it('rejects NaN, which passes every range check there is', () => {
		// finite() comes first in the pipe for exactly this reason
		expect(validateValue(NodeType.JOB, 'cutDepth', NaN)).not.toEqual([]);
		expect(validateValue(NodeType.PROJECT, 'workZero', { x: 0, y: Infinity })).not.toEqual([]);
	});

	it('rejects an option nobody offered', () => {
		expect(validateValue(NodeType.JOB, 'direction', 'sideways')).not.toEqual([]);
	});

	it('accepts an absent inheritable field, and rejects a bad one', () => {
		const job = createNode(NodeType.JOB, {}, { newId: () => 'x' });

		expect(validateNode(job)).toEqual([]);
		job.cutFeed = -5;
		expect(validateNode(job)).not.toEqual([]);
	});

	it('refuses to be asked about a field that does not exist', () => {
		expect(() => validateValue(NodeType.TAB, 'nope', 1)).toThrow(/no field "nope"/);
	});
});


describe('live-linked inheritance', () => {

	it('takes the tool’s value when the job has no opinion', () => {
		const { document, n } = fixture();
		const resolved = resolveField(document, n.a.id, 'cutFeed');

		expect(resolved).toMatchObject({ value: 1000, source: Source.INHERITED, from: n.tool.id });
	});

	it('follows the tool when the tool changes, for jobs made before the change', () => {
		const { document, n } = fixture();

		document.nodes[n.tool.id].cutFeed = 650;

		expect(resolveField(document, n.a.id, 'cutFeed').value).toBe(650);
		expect(resolveField(document, n.b.id, 'cutFeed').value).toBe(650);
	});

	it('stops following once the job disagrees, and starts again when it stops', () => {
		const { document, n } = fixture();

		document.nodes[n.a.id].cutFeed = 400;
		document.nodes[n.tool.id].cutFeed = 650;

		expect(resolveField(document, n.a.id, 'cutFeed')).toMatchObject({ value: 400, source: Source.OWN });
		expect(resolveField(document, n.b.id, 'cutFeed').value).toBe(650);

		delete document.nodes[n.a.id].cutFeed;
		expect(resolveField(document, n.a.id, 'cutFeed').value).toBe(650);
	});

	it('reaches past the job to the project, for a tab', () => {
		const { document, n } = fixture();

		document.nodes[document.root].defaultTabDepth = 3;

		expect(resolveField(document, n.tab.id, 'depth'))
			.toMatchObject({ value: 3, source: Source.INHERITED, from: document.root });
	});

	it('falls back to the spec default when there is nothing above to ask', () => {
		const orphan = createNode(NodeType.JOB, {}, { newId: () => 'x' });
		const document = { root: 'x', nodes: { x: orphan }, selection: { active: null, ids: [] } };

		expect(resolveField(document, 'x', 'cutFeed')).toMatchObject({ value: 1000, source: Source.DEFAULT });
	});

	it('lists exactly the fields a node has an opinion about', () => {
		const { document, n } = fixture();

		expect(overridesOf(document, n.a.id)).toEqual([]);
		document.nodes[n.a.id].cutFeed = 400;
		expect(overridesOf(document, n.a.id)).toEqual(['cutFeed']);
	});

	it('names which nodes a tool’s value is actually reaching', () => {
		const { document, n } = fixture();

		expect(dependentsOf(document, n.tool.id, 'cutFeed').sort()).toEqual([n.a.id, n.b.id].sort());

		document.nodes[n.a.id].cutFeed = 400;
		expect(dependentsOf(document, n.tool.id, 'cutFeed')).toEqual([n.b.id]);
	});

	it('resolves a whole node into something the CAM core can be handed', () => {
		const { document, n } = fixture();
		const values = resolvedValues(document, n.a.id);

		expect(values).toMatchObject({
			operation: 'center', cutDepth: 1, passDepth: 1, cutFeed: 1000, stepover: 0.4,
		});
		expect(Object.keys(values).sort()).toEqual(Object.keys(fieldsOf(NodeType.JOB)).sort());
	});

	it('gives the Inspector provenance for every field in one pass', () => {
		const { document, n } = fixture();
		const resolved = resolveNode(document, n.a.id);

		expect(resolved.cutDepth.source).toBe(Source.OWN);
		expect(resolved.cutFeed.source).toBe(Source.INHERITED);
		expect(resolved.cutFeed.spec.label).toBe('Cut feed');
	});

	it('refuses a field the node does not have', () => {
		const { document, n } = fixture();

		expect(() => resolveField(document, n.tab.id, 'cutFeed')).toThrow(/Tab has no field/);
	});
});


describe('geometry, which lives outside the document', () => {

	it('is not part of what undo copies', () => {
		const { project } = fixture();

		expect('geometry' in project.document).toBe(false);
		expect(project.geometry).toEqual({});
	});

	it('knows which entries are still pointed at, in all three side stores', () => {
		const { project, document, n } = fixture();

		document.nodes[n.open.id].geometry = 'g1';
		document.nodes[n.doc.id].source = 'skyline.svg';
		project.geometry = { g1: [[0, 0]], g2: [[1, 1]] };
		project.sources = { 'skyline.svg': '<svg/>', 'old.svg': '<svg/>' };

		expect([...referenced(document, 'geometry')]).toEqual(['g1']);
		expect(pruneProject(project)).toEqual({
			geometry: { g1: [[0, 0]] },
			assets: {},
			sources: { 'skyline.svg': '<svg/>' },
			dropped: { geometry: ['g2'], assets: [], sources: ['old.svg'] },
		});
	});
});
