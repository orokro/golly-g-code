import { describe, it, expect, vi } from 'vitest';

import { NodeType, FolderRole, createNode } from '@core/project/nodes.js';
import { createProject } from '@core/project/document.js';
import { folderOf, childrenOf } from '@core/project/tree.js';
import { packProject, unpackProject } from '@core/project/file.js';
import { setField } from '@core/project/commands.js';

import { createProjectStore } from './projectStore.js';
import { createRecentFiles, readRecent, promote, RECENT_LIMIT, RECENT_KEY } from './recentFiles.js';
import { useProjectFile, Answer } from './projectFile.js';

/** Deterministic ids. */
const counter = (prefix = 'n') => { let k = 0; return () => `${prefix}${(k += 1)}`; };

/** A localStorage that lives in memory. */
const fakeStorage = () => {
	const map = new Map();
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => map.set(k, v),
		map,
	};
};

/**
 * A fake Electron surface with a filesystem in a Map.
 *
 * @param {Object} [answers] - what the dialogs should return
 * @returns {Object} the api, plus the disk and a log of what was asked
 */
function fakeApi(answers = {}) {

	const disk = new Map();
	const asked = [];

	const api = {
		disk,
		asked,
		openFileDialog: vi.fn(async () => answers.open ?? null),
		saveFileDialog: vi.fn(async () => answers.saveTo ?? null),
		messageBox: vi.fn(async (opts) => { asked.push(opts); return answers.button ?? 2; }),
		readText: vi.fn(async (p) => {
			if (disk.has(p) === false)
				throw new Error(`ENOENT: no such file, open '${p}'`);
			return new TextDecoder().decode(disk.get(p));
		}),
		readBinary: vi.fn(async (p) => {
			if (disk.has(p) === false)
				throw new Error(`ENOENT: no such file, open '${p}'`);
			return disk.get(p).buffer;
		}),
		writeBinary: vi.fn(async (p, bytes) => {
			if (answers.writeFails === true)
				throw new Error('EACCES: permission denied');
			disk.set(p, new Uint8Array(bytes));
			return true;
		}),
	};

	return api;
}

/**
 * A store with a tool and a job, plus a file layer over it.
 *
 * @param {Object} [answers] - dialog answers for the fake api
 * @returns {Object} everything the tests need
 */
function fixture(answers = {}) {

	const newId = counter();
	const project = createProject({ name: 'Skyline', newId });
	const document = project.document;
	const put = (parentId, node) => {
		document.nodes[node.id] = node;
		document.nodes[parentId].children.push(node.id);
		return node;
	};

	const doc = put(folderOf(document, FolderRole.SVGS).id,
		createNode(NodeType.SVG_DOC, { name: 'a.svg' }, { newId }));
	const path = put(doc.id, createNode(NodeType.SVG_PATH, { name: 'line', closed: false }, { newId }));
	const tool = put(folderOf(document, FolderRole.JOBS).id,
		createNode(NodeType.TOOL, { name: 'Bit' }, { newId }));
	const job = put(tool.id, createNode(NodeType.JOB, { name: 'Cut', paths: [path.id] }, { newId }));

	const store = createProjectStore({ project });
	const api = fakeApi(answers);
	const storage = fakeStorage();
	const recent = createRecentFiles({ storage, now: () => 1000 });
	const file = useProjectFile({ store, api, recent, newId: counter('fresh') });

	return { store, api, file, recent, storage, n: { doc, path, tool, job } };
}

/** Makes the store dirty. */
const touch = ({ store, n }) => store.dispatch(setField(store.document, n.job.id, 'cutDepth', 4));


describe('the recent list', () => {

	it('survives whatever is in storage', () => {
		// untrusted input, same rule as a restored layout and a loaded project
		expect(readRecent(null)).toEqual([]);
		expect(readRecent('nonsense')).toEqual([]);
		expect(readRecent([{ path: '/a', name: 'A', at: 1 }, null, { path: 5 }, { path: '/b' }]))
			.toEqual([{ path: '/a', name: 'A', at: 1 }]);
	});

	it('does not choke on a corrupt stored value', () => {
		const storage = fakeStorage();
		storage.setItem(RECENT_KEY, '{ not json');

		expect(createRecentFiles({ storage }).files.value).toEqual([]);
	});

	it('moves a reopened file up instead of listing it twice', () => {
		const list = [{ path: '/a', name: 'A', at: 1 }, { path: '/b', name: 'B', at: 2 }];

		expect(promote(list, { path: '/b', name: 'B', at: 9 }).map((e) => e.path)).toEqual(['/b', '/a']);
	});

	it('stays short', () => {
		let list = [];
		for (let i = 0; i < RECENT_LIMIT + 5; i += 1)
			list = promote(list, { path: `/f${i}`, name: 'x', at: i });

		expect(list).toHaveLength(RECENT_LIMIT);
	});

	it('keeps working when storage refuses to be written', () => {
		const storage = { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } };
		const recent = createRecentFiles({ storage });

		expect(() => recent.remember('/a', 'A')).not.toThrow();
		expect(recent.files.value).toHaveLength(1);
	});
});


describe('saving', () => {

	it('asks where to put a project that has never been saved', async () => {
		const f = fixture({ saveTo: '/work/sky.gollyg' });
		touch(f);

		expect(await f.file.save()).toBe(true);
		expect(f.api.saveFileDialog).toHaveBeenCalledOnce();
		expect(f.file.path.value).toBe('/work/sky.gollyg');
		expect(f.store.dirty.value).toBe(false);
	});

	it('does not ask again once it knows where the project lives', async () => {
		const f = fixture({ saveTo: '/work/sky.gollyg' });
		touch(f);
		await f.file.save();

		touch(f);
		expect(await f.file.save()).toBe(true);
		expect(f.api.saveFileDialog).toHaveBeenCalledOnce();
	});

	it('writes something that reads back as the same project', async () => {
		const f = fixture({ saveTo: '/work/sky.gollyg' });
		touch(f);
		await f.file.save();

		const back = unpackProject(f.api.disk.get('/work/sky.gollyg'));

		expect(back.document.nodes[f.n.job.id].cutDepth).toBe(4);
	});

	it('leaves the project dirty when the dialog is cancelled', async () => {
		const f = fixture({ saveTo: null });
		touch(f);

		expect(await f.file.save()).toBe(false);
		expect(f.store.dirty.value).toBe(true);
		expect(f.file.path.value).toBeNull();
	});

	it('leaves the project dirty when the WRITE fails, and says so', async () => {
		// clearing the flag first would leave the app claiming there is nothing to
		// save, which is the one state from which work actually disappears
		const f = fixture({ saveTo: '/read-only/sky.gollyg', writeFails: true });
		touch(f);

		expect(await f.file.save()).toBe(false);
		expect(f.store.dirty.value).toBe(true);
		expect(f.file.lastError.value).toMatch(/EACCES/);
		expect(f.api.asked.at(-1)).toMatchObject({ type: 'error' });
	});

	it('remembers where it saved', async () => {
		const f = fixture({ saveTo: '/work/sky.gollyg' });
		touch(f);
		await f.file.save();

		expect(f.file.recent.value[0]).toMatchObject({ path: '/work/sky.gollyg', name: 'Skyline' });
		expect(JSON.parse(f.storage.map.get(RECENT_KEY))[0].path).toBe('/work/sky.gollyg');
	});
});


describe('opening', () => {

	/**
	 * Puts a saved project on the fake disk.
	 *
	 * @param {Object} f - a fixture
	 * @param {String} at - where to put it
	 * @param {String} [name] - the project's name
	 */
	const plant = (f, at, name = 'Other') => {
		const other = createProject({ name, newId: counter('o') });
		f.api.disk.set(at, packProject(other));
	};

	it('reads a file and replaces what is open', async () => {
		const f = fixture({ open: ['/work/other.gollyg'] });
		plant(f, '/work/other.gollyg');

		expect(await f.file.open()).toBe(true);
		expect(f.file.name.value).toBe('Other');
		expect(f.file.path.value).toBe('/work/other.gollyg');
		expect(f.store.dirty.value).toBe(false);
		expect(f.store.canUndo.value).toBe(false);
	});

	it('opens a path directly, for the recent list', async () => {
		const f = fixture();
		plant(f, '/work/direct.gollyg');

		expect(await f.file.open('/work/direct.gollyg')).toBe(true);
		expect(f.api.openFileDialog).not.toHaveBeenCalled();
	});

	it('does nothing when the dialog is cancelled', async () => {
		const f = fixture({ open: null });

		expect(await f.file.open()).toBe(false);
		expect(f.file.name.value).toBe('Skyline');
	});

	it('shows the file’s own explanation when it will not open', async () => {
		const f = fixture();
		f.api.disk.set('/work/broken.gollyg', new Uint8Array([1, 2, 3, 4]));

		expect(await f.file.open('/work/broken.gollyg')).toBe(false);
		expect(f.api.asked.at(-1)).toMatchObject({ type: 'error' });
		expect(f.api.asked.at(-1).detail).toMatch(/not a GollyGCode project file/);
		expect(f.file.name.value).toBe('Skyline');
	});

	it('drops a file from the recent list when it will not open', async () => {
		// an unopenable file is not a recent file
		const f = fixture();
		f.recent.remember('/work/gone.gollyg', 'Gone');

		await f.file.open('/work/gone.gollyg');

		expect(f.file.recent.value).toEqual([]);
	});
});


describe('the unsaved-changes guard', () => {

	it('does not ask when there is nothing to lose', async () => {
		const f = fixture({ saveTo: '/work/x.gollyg' });

		expect(await f.file.newProject()).toBe(true);
		expect(f.api.messageBox).not.toHaveBeenCalled();
	});

	it('asks before New throws work away', async () => {
		const f = fixture({ button: 1 });
		touch(f);

		expect(await f.file.newProject()).toBe(true);
		expect(f.api.asked[0].message).toMatch(/Save changes to Skyline\?/);
		expect(f.file.name.value).toBe('Untitled');
	});

	it('asks before Open throws work away', async () => {
		const f = fixture({ button: 1, open: ['/work/other.gollyg'] });
		f.api.disk.set('/work/other.gollyg', packProject(createProject({ name: 'Other', newId: counter('o') })));
		touch(f);

		expect(await f.file.open()).toBe(true);
		expect(f.api.messageBox).toHaveBeenCalledOnce();
	});

	it('does nothing at all on Cancel', async () => {
		const f = fixture({ button: 2 });
		touch(f);

		expect(await f.file.newProject()).toBe(false);
		expect(f.file.name.value).toBe('Skyline');
		expect(f.store.dirty.value).toBe(true);
	});

	it('saves first when asked to, then goes ahead', async () => {
		const f = fixture({ button: 0, saveTo: '/work/sky.gollyg' });
		touch(f);

		expect(await f.file.newProject()).toBe(true);
		expect(f.api.disk.has('/work/sky.gollyg')).toBe(true);
		expect(f.file.name.value).toBe('Untitled');
	});

	it('does NOT throw the work away when that save is itself cancelled', async () => {
		// Save -> the file dialog -> Cancel. The obvious implementation treats
		// "not Cancel" as "go ahead" and loses everything at the second dialog
		const f = fixture({ button: 0, saveTo: null });
		touch(f);

		expect(await f.file.newProject()).toBe(false);
		expect(f.file.name.value).toBe('Skyline');
		expect(f.store.dirty.value).toBe(true);
	});

	it('never puts the destructive choice under the Enter key', async () => {
		const f = fixture({ button: 2 });
		touch(f);
		await f.file.newProject();

		const asked = f.api.asked[0];

		expect(asked.buttons[asked.defaultId]).toBe('Save');
		expect(asked.buttons[asked.cancelId]).toBe('Cancel');
		expect(asked.buttons[Object.values(Answer).indexOf(Answer.DISCARD)]).toBe("Don't save");
	});

	it('is the same guard that closing goes through', async () => {
		const f = fixture({ button: 2 });
		touch(f);

		expect(await f.file.requestClose()).toBe(false);

		f.api.messageBox.mockResolvedValue(1);
		expect(await f.file.requestClose()).toBe(true);
	});

	it('lets a clean window close without a word', async () => {
		const f = fixture();

		expect(await f.file.requestClose()).toBe(true);
		expect(f.api.messageBox).not.toHaveBeenCalled();
	});
});


describe('what the title bar says', () => {

	it('marks unsaved work, and stops when it is saved', async () => {
		const f = fixture({ saveTo: '/work/sky.gollyg' });

		expect(f.file.title.value).toBe('Skyline — GollyGCode');

		touch(f);
		expect(f.file.title.value).toBe('• Skyline — GollyGCode');

		await f.file.save();
		expect(f.file.title.value).toBe('Skyline — GollyGCode');
	});

	it('follows a rename', () => {
		const f = fixture();

		f.store.dispatch(setField(f.store.document, f.store.id, 'name', 'Sign'));

		expect(f.file.name.value).toBe('Sign');
	});
});


describe('importing drawings', () => {

	/** A drawing with a square and a line. */
	const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm"'
		+ ' viewBox="0 0 100 100"><rect id="plate" x="0" y="0" width="10" height="10"/>'
		+ '<path id="line" d="M20 0 L30 10"/></svg>';

	/**
	 * Puts a text file on the fake disk.
	 *
	 * @param {Object} f - a fixture
	 * @param {String} at - where
	 * @param {String} text - what
	 */
	const plantText = (f, at, text) => f.api.disk.set(at, new TextEncoder().encode(text));

	it('turns a file into nodes, geometry and a kept original', () => {
		const f = fixture();
		plantText(f, '/art/parts.svg', SVG);

		return f.file.importSvg(['/art/parts.svg']).then((result) => {

			expect(result.imported).toBe(1);

			const svgs = folderOf(f.store.document, FolderRole.SVGS);
			const doc = childrenOf(f.store.document, svgs.id).at(-1);

			expect(doc.name).toBe('parts.svg');
			expect(childrenOf(f.store.document, doc.id).map((n) => n.name)).toEqual(['plate', 'line']);
			expect(Object.keys(f.store.project.geometry)).toHaveLength(2);
			expect(f.store.project.sources['parts.svg']).toBe(SVG);
		});
	});

	it('is one undo entry per FILE, not per path and not per batch', () => {
		// three drawings imported and wanting two of them back is a real thing
		// the fixture already contains an "a.svg", so these are named to stay
		// distinguishable from it -- the first version of this asserted on a list
		// that had the fixture's document in it and read as a duplicate
		const f = fixture();
		plantText(f, '/art/one.svg', SVG);
		plantText(f, '/art/two.svg', SVG);

		return f.file.importSvg(['/art/one.svg', '/art/two.svg']).then(() => {

			expect(f.store.undoLabel.value).toBe('Import two.svg');

			f.store.undo();
			const svgs = folderOf(f.store.document, FolderRole.SVGS);
			expect(childrenOf(f.store.document, svgs.id).map((n) => n.name))
				.toEqual(['a.svg', 'one.svg']);
		});
	});

	it('keeps both originals when the same filename is imported twice', () => {
		const f = fixture();
		plantText(f, '/art/parts.svg', SVG);
		plantText(f, '/other/parts.svg', SVG.replace('plate', 'plate2'));

		return f.file.importSvg(['/art/parts.svg', '/other/parts.svg']).then(() => {
			expect(Object.keys(f.store.project.sources).sort()).toEqual(['parts (2).svg', 'parts.svg']);
		});
	});

	it('reports a file it could not read without abandoning the rest', () => {
		const f = fixture();
		plantText(f, '/art/good.svg', SVG);
		plantText(f, '/art/bad.svg', 'not an svg at all');

		return f.file.importSvg(['/art/bad.svg', '/art/good.svg']).then((result) => {
			expect(result.imported).toBe(1);
			expect(result.warnings.join(' ')).toMatch(/bad\.svg/);
			expect(f.api.asked.at(-1)).toMatchObject({ type: 'info' });
		});
	});

	it('says so when nothing at all could be imported', () => {
		const f = fixture();
		plantText(f, '/art/bad.svg', 'nope');

		return f.file.importSvg(['/art/bad.svg']).then((result) => {
			expect(result.imported).toBe(0);
			expect(f.api.asked.at(-1)).toMatchObject({ type: 'error' });
		});
	});

	it('does nothing when the dialog is cancelled', () => {
		const f = fixture({ open: null });

		return f.file.importSvg().then((result) => {
			expect(result.imported).toBe(0);
			expect(f.store.canUndo.value).toBe(false);
		});
	});

	it('brings a reference image in as bytes, outside the document', () => {
		const f = fixture();
		f.api.disk.set('/art/photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

		return f.file.importReference(['/art/photo.png']).then((count) => {

			expect(count).toBe(1);

			const refs = folderOf(f.store.document, FolderRole.REFERENCES);
			const image = childrenOf(f.store.document, refs.id)[0];

			expect(image.name).toBe('photo.png');
			expect([...f.store.project.assets[image.asset]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
		});
	});
});


describe('the wiring itself', () => {

	it('refuses to be built without a store or an api', () => {
		expect(() => useProjectFile({})).toThrow(/needs a store and an api/);
		expect(() => useProjectFile()).toThrow(/needs a store and an api/);
	});
});
