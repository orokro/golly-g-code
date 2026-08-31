import { describe, it, expect, vi } from 'vitest';
import { shallowRef } from 'vue';

import { createProject } from '@core/project/document.js';
import { createProjectStore } from './projectStore.js';
import { setField } from '@core/project/commands.js';
import { useProgramFile, suggestedProgramName, GCODE_FILTER } from './programFile.js';

/**
 * A store, a stand-in program, and a recording Electron surface.
 *
 * @param {Object} [program] - overrides for the program's refs
 * @returns {Object} everything the tests need
 */
function fixture(program = {}) {

	const store = createProjectStore({ project: createProject() });

	const stub = {
		text: shallowRef('G21\nG90\n'),
		stale: shallowRef(false),
		blocked: shallowRef([]),
		...program,
	};

	const api = {
		saveFileDialog: vi.fn(async () => '/tmp/part.nc'),
		writeText: vi.fn(async () => undefined),
	};

	return { store, program: stub, api, file: useProgramFile({ store, program: stub, api }) };
}


describe('exporting', () => {

	it('writes what was on screen, to where the user said', async () => {
		const f = fixture();
		expect(await f.file.exportProgram()).toBe(true);
		expect(f.api.writeText).toHaveBeenCalledWith('/tmp/part.nc', 'G21\nG90\n');
		expect(f.file.lastPath.value).toBe('/tmp/part.nc');
	});

	it('offers the project’s name and the G-code filter', async () => {
		const f = fixture();
		await f.file.exportProgram();
		expect(f.api.saveFileDialog).toHaveBeenCalledWith(expect.objectContaining({
			filters: [GCODE_FILTER],
		}));
	});

	it('writes nothing when the dialog is cancelled', async () => {
		const f = fixture();
		f.api.saveFileDialog.mockResolvedValue(null);
		expect(await f.file.exportProgram()).toBe(false);
		expect(f.api.writeText).not.toHaveBeenCalled();
	});

	it('reports a failed write instead of claiming it worked', async () => {
		const f = fixture();
		f.api.writeText.mockRejectedValue(new Error('disk is full'));
		expect(await f.file.exportProgram()).toBe(false);
		expect(f.file.error.value).toBe('disk is full');
		expect(f.file.lastPath.value).toBe(null);
	});

	it('stops saying it is exporting after a failure', async () => {
		const f = fixture();
		f.api.writeText.mockRejectedValue(new Error('nope'));
		await f.file.exportProgram();
		expect(f.file.exporting.value).toBe(false);
	});
});


describe('what it refuses, which is the point of it', () => {

	it('refuses while the program is still catching up', async () => {
		const f = fixture({ stale: shallowRef(true) });
		expect(await f.file.exportProgram()).toBe(false);
		expect(f.api.saveFileDialog).not.toHaveBeenCalled();
		expect(f.file.error.value).toMatch(/still being generated/);
	});

	it('refuses when a diagnostic blocks export', async () => {
		const f = fixture({ blocked: shallowRef([{ message: 'no depth' }]) });
		expect(await f.file.exportProgram()).toBe(false);
		expect(f.api.saveFileDialog).not.toHaveBeenCalled();
	});

	it('refuses when there is nothing to write', async () => {
		const f = fixture({ text: shallowRef('') });
		expect(await f.file.exportProgram()).toBe(false);
		expect(f.api.saveFileDialog).not.toHaveBeenCalled();
	});

	it('writes nothing when the project changed while the dialog was open', async () => {

		// A native save dialog is modal to nothing in particular and can sit open
		// for a minute. The text captured when the button was pressed is the text
		// the user meant; by the time they pick a filename the document may be a
		// different part, and writing the captured text under the new name would
		// be the worst of both.
		const f = fixture();
		f.api.saveFileDialog.mockImplementation(async () => {
			f.store.dispatch(setField(f.store.document, f.store.document.root, 'name', 'Something else'));
			return '/tmp/part.nc';
		});

		expect(await f.file.exportProgram()).toBe(false);
		expect(f.api.writeText).not.toHaveBeenCalled();
		expect(f.file.error.value).toMatch(/changed while the dialog was open/);
	});

	it('clears the last error when a later export succeeds', async () => {
		const f = fixture({ stale: shallowRef(true) });
		await f.file.exportProgram();
		expect(f.file.error.value).not.toBe(null);

		f.program.stale.value = false;
		await f.file.exportProgram();
		expect(f.file.error.value).toBe(null);
	});
});


describe('the suggested filename', () => {

	it('is the project’s name with an extension', () => {
		const project = createProject();
		project.document.nodes[project.document.root].name = 'Bracket';
		expect(suggestedProgramName(project.document)).toBe('Bracket.nc');
	});

	it('strips what a filesystem would refuse', () => {
		const project = createProject();
		project.document.nodes[project.document.root].name = 'a/b:c*d?';
		expect(suggestedProgramName(project.document)).toBe('abcd.nc');
	});

	it('falls back rather than offering a file called ".nc"', () => {
		const project = createProject();
		project.document.nodes[project.document.root].name = '///';
		expect(suggestedProgramName(project.document)).toBe('program.nc');
	});
});
