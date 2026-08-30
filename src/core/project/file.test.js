import { describe, it, expect } from 'vitest';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

import { NodeType, FolderRole, createNode } from './nodes.js';
import { createProject, DOCUMENT_VERSION, pruneProject } from './document.js';
import { folderOf } from './tree.js';
import { diffStates } from './snapshot.js';
import {
	EXTENSION, FILE_FILTER, MIGRATIONS,
	migrate, packProject, unpackProject, suggestedFilename,
} from './file.js';

/** Deterministic ids. */
const counter = () => { let n = 0; return () => `n${(n += 1)}`; };

/**
 * A project with an SVG, a reference image, a tool, a job and a tab.
 *
 * @returns {Object} `{ project, n }`
 */
function fixture() {

	const newId = counter();
	const project = createProject({ name: 'Skyline', newId });
	const document = project.document;
	const put = (parentId, node) => {
		document.nodes[node.id] = node;
		document.nodes[parentId].children.push(node.id);
		return node;
	};

	const doc = put(folderOf(document, FolderRole.SVGS).id,
		createNode(NodeType.SVG_DOC, { name: 'skyline.svg', source: 'skyline.svg' }, { newId }));
	const path = put(doc.id, createNode(NodeType.SVG_PATH,
		{ name: 'outline', closed: false, geometry: 'g1' }, { newId }));

	const image = put(folderOf(document, FolderRole.REFERENCES).id,
		createNode(NodeType.REFERENCE_IMAGE, { name: 'photo', asset: 'a1' }, { newId }));

	const tool = put(folderOf(document, FolderRole.JOBS).id,
		createNode(NodeType.TOOL, { name: '1/8 flat' }, { newId }));
	const job = put(tool.id, createNode(NodeType.JOB,
		{ name: 'Skyline', paths: [path.id], cutDepth: 5 }, { newId }));
	put(job.id, createNode(NodeType.TAB, { name: 'Tab 1', position: 20 }, { newId }));

	project.geometry = { g1: [[0, 0], [10, 0], [10, 10]] };
	project.assets = { a1: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) };
	// deliberately full of the things a normaliser would tidy away: a prolog, a
	// comment, indentation, blank lines, CRLF, and a trailing newline. The first
	// version of this was a single tight line, so "byte for byte" passed even
	// when the source was being whitespace-collapsed on the way in
	project.sources = { 'skyline.svg': SVG };

	return { project, n: { doc, path, image, tool, job } };
}

/** An SVG with every kind of whitespace a well-meaning rewriter might eat. */
const SVG = '<?xml version="1.0" encoding="UTF-8"?>\r\n'
	+ '<!-- drawn in Illustrator, do not reformat -->\n'
	+ '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n'
	+ '\n'
	+ '\t<path   d="M0 0 L10 10"   />\n'
	+ '</svg>\n';

/** Packs at a fixed time, so a round trip is comparable. */
const pack = (project) => packProject(project, { now: () => Date.UTC(2026, 7, 30, 12) });


describe('the container', () => {

	it('is a zip laid out the way the format says', () => {
		const entries = Object.keys(unzipSync(pack(fixture().project))).sort();

		expect(entries).toEqual(['assets/a1', 'geometry.json', 'project.json', 'svg/skyline.svg']);
	});

	it('keeps the SVG byte for byte, so it stays re-importable', () => {
		// the point of keeping originals at all: the drawing can be fixed in
		// Illustrator and reimported without the round trip through us having
		// quietly changed anything
		const { project } = fixture();
		const bytes = unzipSync(pack(project))['svg/skyline.svg'];

		expect(strFromU8(bytes)).toBe(SVG);
		expect(bytes.length).toBe(new TextEncoder().encode(SVG).length);
		expect(unpackProject(pack(project)).sources['skyline.svg']).toBe(SVG);
	});

	it('records what wrote it and when', () => {
		const written = JSON.parse(strFromU8(unzipSync(pack(fixture().project))['project.json']));

		expect(written).toMatchObject({ version: DOCUMENT_VERSION, application: 'GollyGCode' });
		expect(written.savedAt).toBe('2026-08-30T12:00:00.000Z');
	});

	it('suggests a filename from the project name', () => {
		const { project } = fixture();

		expect(suggestedFilename(project)).toBe(`Skyline.${EXTENSION}`);

		project.document.nodes[project.document.root].name = 'Sign / v2: "final"';
		expect(suggestedFilename(project)).toBe('Sign  v2 final.gollyg');
	});

	it('offers the dialogs something to filter on', () => {
		expect(FILE_FILTER).toEqual({ name: 'GollyGCode project', extensions: ['gollyg'] });
	});
});


describe('the round trip', () => {

	it('brings the document back exactly', () => {
		const { project } = fixture();

		const back = unpackProject(pack(project));

		expect(diffStates(project.document, back.document)).toEqual([]);
	});

	it('brings the geometry, the images and the SVGs back', () => {
		const { project } = fixture();

		const back = unpackProject(pack(project));

		expect(back.geometry).toEqual({ g1: [[0, 0], [10, 0], [10, 10]] });
		expect([...back.assets.a1]).toEqual([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		expect(back.sources['skyline.svg']).toBe(SVG);
	});

	it('survives a project with nothing in it', () => {
		const empty = createProject({ newId: counter() });

		const back = unpackProject(pack(empty));

		expect(diffStates(empty.document, back.document)).toEqual([]);
		expect(back.geometry).toEqual({});
	});

	it('forgets side-store entries nothing points at — on SAVE, and only there', () => {
		// the one moment it is safe: doing it after an undo would throw away what
		// the matching redo wants back
		const { project } = fixture();
		project.geometry.orphan = [[9, 9]];
		project.sources['unused.svg'] = '<svg/>';

		expect(pruneProject(project).dropped).toEqual({
			geometry: ['orphan'], assets: [], sources: ['unused.svg'],
		});

		const back = unpackProject(pack(project));

		expect(Object.keys(back.geometry)).toEqual(['g1']);
		expect(Object.keys(back.sources)).toEqual(['skyline.svg']);
	});
});


describe('migration', () => {

	it('has a table, even though there is nothing in it yet', () => {
		// the migration you need is always for files written before you thought
		// about migrations
		expect(MIGRATIONS).toEqual({});
	});

	it('leaves a current file alone', () => {
		const raw = { version: DOCUMENT_VERSION, document: {} };

		expect(migrate(raw)).toBe(raw);
	});

	it('walks a file forward one version at a time', () => {
		// There is only one real version, so the multi-step walk is exercised with
		// a synthetic table starting below it. Artificial, and the alternative is
		// an untested loop that first runs for real on somebody's only copy of a
		// project.
		const steps = [];
		const table = {
			'-1': (p) => { steps.push(-1); return { ...p, first: true }; },
			0: (p) => { steps.push(0); return { ...p, second: true }; },
		};

		const result = migrate({ version: -1, document: {} }, table);

		expect(steps).toEqual([-1, 0]);
		expect(result).toMatchObject({ first: true, second: true, version: DOCUMENT_VERSION });
	});

	it('REFUSES a file from the future rather than loading the parts it recognises', () => {
		// the important half of having versions. Loading what we understand means
		// silently dropping the rest and then saving that back over the original
		expect(() => migrate({ version: DOCUMENT_VERSION + 1, document: {} }))
			.toThrow(/saved by a newer version of GollyGCode \(format 2\).*understands up to format 1/s);
	});

	it('refuses a file with no version at all', () => {
		expect(() => migrate({ document: {} })).toThrow(/no format version/);
		expect(() => migrate({ version: '1' })).toThrow(/no format version/);
	});

	it('refuses a version it cannot bridge', () => {
		expect(() => migrate({ version: -2, document: {} }, {}))
			.toThrow(/format -2 and there is no way to bring it forward/);
	});
});


describe('refusing a file rather than half-loading it', () => {

	/**
	 * Builds an archive by hand.
	 *
	 * @param {Object} entries - name to string contents
	 * @returns {Uint8Array} the zip
	 */
	const archive = (entries) => zipSync(Object.fromEntries(
		Object.entries(entries).map(([name, text]) => [name, strToU8(text)])));

	it('says plainly when the bytes are not a zip', () => {
		expect(() => unpackProject(new Uint8Array([1, 2, 3, 4])))
			.toThrow(/not a GollyGCode project file/);
	});

	it('says plainly when the zip has no project.json', () => {
		expect(() => unpackProject(archive({ 'geometry.json': '{}' })))
			.toThrow(/no project\.json/);
	});

	it('blames project.json when project.json is the damaged part', () => {
		expect(() => unpackProject(archive({ 'project.json': '{ "version": 1, ' })))
			.toThrow(/project\.json inside this file is damaged/);
	});

	it('blames geometry.json when geometry.json is', () => {
		const { project } = fixture();
		const files = unzipSync(pack(project));
		files['geometry.json'] = strToU8('{{{');

		expect(() => unpackProject(zipSync(files))).toThrow(/geometry\.json inside this file is damaged/);
	});

	it('refuses an entry whose name tries to escape the archive', () => {
		// a .gollyg is a file people send each other, so zip slip gets caught
		// where the name is read rather than wherever it is used later
		for (const name of ['../../.bashrc', '/etc/passwd', 'C:\\windows\\x', 'svg/../../x'])
			expect(() => unpackProject(archive({ 'project.json': '{"version":1}', [name]: 'x' })),
				name).toThrow(/unsafe name/);
	});

	it('refuses a document that has been hand-edited into nonsense', () => {
		const { project, n } = fixture();
		project.document.nodes[n.tool.id].children.push('ghost');

		expect(() => unpackProject(pack(project))).toThrow(/damaged[\s\S]*lists a child "ghost"/);
	});

	it('refuses a node whose settings are out of range', () => {
		const { project, n } = fixture();
		project.document.nodes[n.tool.id].stepover = 4;

		expect(() => unpackProject(pack(project))).toThrow(/settings that make no sense[\s\S]*stepover/);
	});

	it('refuses a file with no tree in it', () => {
		expect(() => unpackProject(archive({ 'project.json': '{"version":1}' })))
			.toThrow(/no project tree/);
	});

	it('can be asked not to validate, for looking at the wreckage', () => {
		const { project, n } = fixture();
		project.document.nodes[n.tool.id].children.push('ghost');

		const back = unpackProject(pack(project), { validate: false });

		expect(back.document.nodes[n.tool.id].children).toContain('ghost');
	});
});
