import { describe, it, expect } from 'vitest';

import { NodeType, FolderRole, FIELDS, fieldsOf, createNode } from '@core/project/nodes.js';
import { createProject } from '@core/project/document.js';
import { folderOf } from '@core/project/tree.js';
import { Source, resolvedValues } from '@core/project/inherit.js';

import {
	GROUPS, MIXED, TYPE_LABEL, inspectorLayout, isRelevant, optionsFor,
} from './layout.js';

/** Deterministic ids. */
const counter = () => { let k = 0; return () => `n${(k += 1)}`; };

/**
 * A project with a tool, two jobs, a tab and a path.
 *
 * The layout now reads the PROJECT rather than the document on its own, because
 * what a job may be set to depends on the outline the job owns.
 *
 * @returns {Object} `{ project, document, n }`
 */
function fixture() {

	const newId = counter();
	const project = createProject({ name: 'P', newId });
	const document = project.document;
	const put = (parentId, node) => {
		document.nodes[node.id] = node;
		document.nodes[parentId].children.push(node.id);
		return node;
	};

	const doc = put(folderOf(document, FolderRole.SVGS).id,
		createNode(NodeType.SVG_DOC, { name: 'a.svg' }, { newId }));
	const path = put(doc.id, createNode(NodeType.SVG_PATH, { name: 'p', closed: true }, { newId }));

	const tool = put(folderOf(document, FolderRole.JOBS).id,
		createNode(NodeType.TOOL, { name: 'Bit' }, { newId }));
	const a = put(tool.id, createNode(NodeType.JOB, { name: 'A', cutDepth: 2 }, { newId }));
	const b = put(tool.id, createNode(NodeType.JOB, { name: 'B', cutDepth: 5 }, { newId }));
	const tab = put(a.id, createNode(NodeType.TAB, { name: 'T', position: 4 }, { newId }));

	return { project, document, n: { doc, path, tool, a, b, tab } };
}

/** A field out of a layout, by name. */
const fieldOf = (layout, name) =>
	layout.groups.flatMap((group) => group.fields).find((f) => f.field === name);


describe('the two tables agreeing', () => {

	it('puts every field of every type in exactly one group', () => {
		// core says what a field IS, this file says where it is DRAWN, and a field
		// added to one and forgotten in the other is simply invisible -- no error,
		// no gap on screen, just a setting nobody can reach
		for (const [type, fields] of Object.entries(FIELDS)) {

			const placed = GROUPS[type].flatMap((group) => group.fields);

			expect(placed.length, `${type} lists a field twice`).toBe(new Set(placed).size);
			expect([...placed].sort(), `${type}`).toEqual(Object.keys(fields).sort());
		}
	});

	it('has a group list for every node type', () => {
		expect(Object.keys(GROUPS).sort()).toEqual(Object.keys(FIELDS).sort());
	});
});


describe('one node selected', () => {

	it('is the easy case of a list, not a separate path', () => {
		const { project, n } = fixture();
		const layout = inspectorLayout(project, [n.a.id]);

		expect(layout.type).toBe(NodeType.JOB);
		expect(layout.title).toBe('A');
		expect(layout.groups.map((g) => g.name)).toEqual(GROUPS[NodeType.JOB].map((g) => g.name));
	});

	it('marks an inherited field as inherited, and says where from', () => {
		const { project, n } = fixture();
		const cutFeed = fieldOf(inspectorLayout(project, [n.a.id]), 'cutFeed');

		expect(cutFeed).toMatchObject({ value: 1000, source: Source.INHERITED, from: n.tool.id, overridden: false });
	});

	it('marks an override, which is what puts a reset button beside it', () => {
		const { project, document, n } = fixture();
		document.nodes[n.a.id].cutFeed = 400;

		expect(fieldOf(inspectorLayout(project, [n.a.id]), 'cutFeed'))
			.toMatchObject({ value: 400, source: Source.OWN, overridden: true });
	});

	it('marks the fields that are shown but not typed into', () => {
		const { project, n } = fixture();
		const layout = inspectorLayout(project, [n.path.id]);

		expect(fieldOf(layout, 'geometry').readOnly).toBe(true);
		expect(fieldOf(layout, 'closed').readOnly).toBe(true);
		expect(fieldOf(layout, 'name').readOnly).toBe(false);
	});

	it('carries the spec, so a control knows what to draw without looking it up', () => {
		const { project, n } = fixture();

		expect(fieldOf(inspectorLayout(project, [n.a.id]), 'cutDepth').spec)
			.toMatchObject({ label: 'Cut depth', kind: 'number', quantity: 'length' });
	});
});


describe('several of the same type', () => {

	it('shows that type’s fields, and agrees where they agree', () => {
		const { project, n } = fixture();
		const layout = inspectorLayout(project, [n.a.id, n.b.id]);

		expect(layout.type).toBe(NodeType.JOB);
		expect(layout.title).toBe('2 jobs');
		expect(fieldOf(layout, 'operation').value).toBe('center');
	});

	it('says MIXED rather than showing whichever was first', () => {
		const { project, n } = fixture();

		expect(fieldOf(inspectorLayout(project, [n.a.id, n.b.id]), 'cutDepth').value).toBe(MIXED);
	});

	it('says mixed for the SOURCE too, when one overrides and the other inherits', () => {
		// both read 400, but one of them is only borrowing it -- resetting the
		// pair would move one and not the other, so they are not the same state
		const { project, document, n } = fixture();
		document.nodes[n.tool.id].cutFeed = 400;
		document.nodes[n.a.id].cutFeed = 400;

		const cutFeed = fieldOf(inspectorLayout(project, [n.a.id, n.b.id]), 'cutFeed');

		expect(cutFeed.value).toBe(400);
		expect(cutFeed.source).toBe('mixed');
		expect(cutFeed.overridden).toBe(true);
	});

	it('compares list and point values properly, not by identity', () => {
		// `source` is the job's reference list now that `paths` is gone: the same
		// shape of value, and still the one field on a job that holds one
		const { project, document, n } = fixture();
		document.nodes[n.a.id].source = [n.path.id];
		document.nodes[n.b.id].source = [n.path.id];

		expect(fieldOf(inspectorLayout(project, [n.a.id, n.b.id]), 'source').value).toEqual([n.path.id]);

		document.nodes[n.b.id].source = [];
		expect(fieldOf(inspectorLayout(project, [n.a.id, n.b.id]), 'source').value).toBe(MIXED);
	});
});


describe('several of different types', () => {

	it('shows only what they all genuinely have', () => {
		// a job's cut depth on a selection that is mostly jobs would be a control
		// that silently does nothing to the rest of it
		const { project, n } = fixture();
		const layout = inspectorLayout(project, [n.a.id, n.tool.id]);

		expect(layout.type).toBeNull();
		expect(layout.title).toBe('2 items');
		expect(layout.groups).toHaveLength(1);
		expect(layout.groups[0].fields.map((f) => f.field).sort()).toEqual(['locked', 'name', 'visible']);
	});

	it('leaves out a field one of them inherits FROM another of them', () => {
		// A Tool and its own Job both have a cutFeed -- the tool's is the source,
		// the job's is the override. One control for the pair would set both, and
		// quietly give the job an override it did not have, so correcting the tool
		// later would no longer move that job. Breaking a link by editing a field
		// that says nothing about links is exactly the kind of thing that makes
		// inheritance feel unreliable.
		const { project, n } = fixture();
		const fields = inspectorLayout(project, [n.a.id, n.tool.id])
			.groups.flatMap((g) => g.fields).map((f) => f.field);

		expect(fields).not.toContain('cutFeed');
		expect(fields).not.toContain('passDepth');
	});

	it('keeps the field when neither inherits from the other', () => {
		// two jobs under different tools is an ordinary multi-edit
		const { project, document, n } = fixture();
		const other = createNode(NodeType.TOOL, { name: 'Other' }, { newId: () => 'x1' });
		const far = createNode(NodeType.JOB, { name: 'Far' }, { newId: () => 'x2' });
		other.children = [far.id];
		document.nodes[other.id] = other;
		document.nodes[far.id] = far;
		folderOf(document, FolderRole.JOBS).children.push(other.id);

		const fields = inspectorLayout(project, [n.a.id, far.id])
			.groups.flatMap((g) => g.fields).map((f) => f.field);

		expect(fields).toContain('cutFeed');
	});

	it('still resolves those fields across the selection', () => {
		const { project, document, n } = fixture();
		document.nodes[n.tool.id].locked = true;

		const layout = inspectorLayout(project, [n.a.id, n.tool.id]);

		expect(fieldOf(layout, 'locked').value).toBe(MIXED);
		expect(fieldOf(layout, 'visible').value).toBe(true);
	});
});


describe('naming the selection', () => {

	it('uses a word for the type, not the identifier', () => {
		// lowercasing SvgPath gets you "2 svgpaths", which is nobody's word
		const { project, n } = fixture();

		expect(inspectorLayout(project, [n.path.id, n.doc.id]).title).toBe('2 items');
		expect(TYPE_LABEL[NodeType.SVG_PATH]).toBe('path');
	});

	it('has a word for every type there is', () => {
		for (const type of Object.keys(FIELDS))
			expect(TYPE_LABEL[type], type).toBeTruthy();
	});
});


describe('nothing selected', () => {

	it('says so, with no groups to draw', () => {
		const { project } = fixture();

		expect(inspectorLayout(project, [])).toMatchObject({ type: null, title: 'Nothing selected', groups: [] });
	});

	it('ignores ids that are not there', () => {
		const { project, n } = fixture();

		expect(inspectorLayout(project, ['ghost', n.a.id]).title).toBe('A');
		expect(inspectorLayout(project, ['ghost']).groups).toEqual([]);
	});
});


describe('fields that do not apply right now', () => {

	/**
	 * Whether a field applies, for a job with some values.
	 *
	 * @param {Object} f - a fixture
	 * @param {Object} overrides - values to set on the job
	 * @param {String} field - the field to ask about
	 * @returns {Boolean} whether it is relevant
	 */
	const relevant = (f, overrides, field) => {
		Object.assign(f.document.nodes[f.n.a.id], overrides);
		return isRelevant(f.document.nodes[f.n.a.id], field, resolvedValues(f.document, f.n.a.id));
	};

	it('dims the open-path fields on a closed-path operation', () => {
		const f = fixture();

		expect(relevant(f, { operation: 'inside' }, 'offsetSide')).toBe(false);
		expect(relevant(f, { operation: 'normal' }, 'offsetSide')).toBe(true);
	});

	it('gives an angle only to the heading mode, which is the one that has one', () => {
		const f = fixture();

		expect(relevant(f, { operation: 'normal' }, 'offsetHeading')).toBe(false);
		expect(relevant(f, { operation: 'heading' }, 'offsetHeading')).toBe(true);
	});

	it('dims a ramp angle when there is no ramp', () => {
		const f = fixture();

		expect(relevant(f, { ramp: false }, 'rampAngle')).toBe(false);
		expect(relevant(f, { ramp: true }, 'rampAngle')).toBe(true);
	});

	it('dims the lead side until there is a lead', () => {
		const f = fixture();

		expect(relevant(f, { leadIn: 0, leadOut: 0 }, 'leadSide')).toBe(false);
		expect(relevant(f, { leadIn: 0, leadOut: 3 }, 'leadSide')).toBe(true);
	});

	it('dims band width and stepover for a single-pass cut', () => {
		const f = fixture();

		expect(relevant(f, { operation: 'center', width: 0 }, 'width')).toBe(false);
		expect(relevant(f, { operation: 'outside', width: 0 }, 'width')).toBe(true);
		expect(relevant(f, { operation: 'center', width: 0 }, 'stepover')).toBe(false);
		expect(relevant(f, { operation: 'pocket' }, 'stepover')).toBe(true);
	});

	it('leaves everything on anything that is not a job', () => {
		const { document, n } = fixture();

		for (const field of Object.keys(fieldsOf(NodeType.TOOL)))
			expect(isRelevant(document.nodes[n.tool.id], field, {}), field).toBe(true);
	});
});


describe('the operation list offers only what the outline can do', () => {

	/** The operation FieldSpec, whatever it currently holds. */
	const spec = FIELDS[NodeType.JOB].operation;

	/**
	 * A project with one job whose outline is open, closed, or both.
	 *
	 * @param {Number} closed - how many closed subpaths
	 * @param {Number} open - how many open subpaths
	 * @param {Object} [fields] - fields for the job node
	 * @param {String} [prefix] - id prefix, so two fixtures do not collide
	 * @returns {Object} `{ project, job }`
	 */
	function withOutline(closed, open, fields = {}, prefix = 'x') {

		let k = 0;
		const newId = () => `${prefix}${(k += 1)}`;
		const project = createProject({ newId });

		// a distinct id per fixture: two jobs sharing one geometry key made the
		// multi-selection test read the same outline twice and pass for the wrong
		// reason
		const key = `g-${closed}-${open}-${Math.random().toString(36).slice(2, 8)}`;
		const job = createNode(NodeType.JOB, { name: 'Cut', geometry: key, ...fields }, { newId });

		project.document.nodes[job.id] = job;
		project.geometry[key] = {
			subPaths: [
				...Array.from({ length: closed }, () => ({ closed: true, segments: [] })),
				...Array.from({ length: open }, () => ({ closed: false, segments: [] })),
			],
		};

		return { project, job };
	}

	it('hides the closed-only operations for an open outline', () => {

		// Greg's report: an open path was cheerfully offered inside, outside and
		// pocket, and picking one produced an error diagnostic and no toolpath.
		const f = withOutline(0, 1);
		const offered = optionsFor(f.project, [f.job], 'operation', spec);

		expect(offered).not.toContain('outside');
		expect(offered).not.toContain('inside');
		expect(offered).not.toContain('pocket');
		expect(offered).toContain('center');
		expect(offered).toContain('normal');
	});

	it('hides the open-only operations for a closed outline', () => {
		const offered = optionsFor(...(() => {
			const f = withOutline(1, 0);
			return [f.project, [f.job], 'operation', spec];
		})());

		expect(offered).not.toContain('normal');
		expect(offered).not.toContain('heading');
		expect(offered).toContain('outside');
	});

	it('offers both when the outline has both', () => {
		const f = withOutline(1, 1);
		const offered = optionsFor(f.project, [f.job], 'operation', spec);
		expect(offered).toEqual(spec.options);
	});

	it('keeps the current value even when it is no longer possible', () => {

		// A select showing nothing is worse than one showing the wrong thing, and
		// the diagnostic already explains why it is wrong.
		const f = withOutline(0, 1, { operation: 'outside' });
		expect(optionsFor(f.project, [f.job], 'operation', spec)).toContain('outside');
	});

	it('offers everything when there is no outline to judge by', () => {
		const f = withOutline(0, 0);
		expect(optionsFor(f.project, [f.job], 'operation', spec)).toEqual(spec.options);
	});

	it('takes only what EVERY selected job can do', () => {
		// distinct id prefixes: identically built fixtures gave both jobs the same
		// id, so putting one into the other's document silently replaced it and
		// the test passed by reading one outline twice
		const a = withOutline(0, 1, {}, 'a');
		const b = withOutline(1, 0, {}, 'b');
		b.project.document.nodes[a.job.id] = a.job;
		b.project.geometry[a.job.geometry] = a.project.geometry[a.job.geometry];

		const offered = optionsFor(b.project, [a.job, b.job], 'operation', spec);

		expect(offered).not.toContain('outside');
		expect(offered).not.toContain('normal');
		expect(offered).toContain('center');
	});

	it('leaves every other select alone', () => {
		const f = withOutline(0, 1);
		expect(optionsFor(f.project, [f.job], 'direction', FIELDS[NodeType.JOB].direction))
			.toEqual(FIELDS[NodeType.JOB].direction.options);
	});
});
