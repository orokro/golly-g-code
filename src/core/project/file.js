/**
 * @file file.js
 * @description Reading and writing `.gollyg` files.
 *
 * A `.gollyg` is a zip:
 *
 *   project.json    { version, savedAt, application, document }
 *   geometry.json   path data by id
 *   svg/<name>      the SVG files as they were imported, byte for byte
 *   assets/<id>     reference images
 *
 * A zip and not one big JSON because of the last two. An SVG kept verbatim stays
 * re-importable — the user can fix the drawing in Illustrator and reimport it
 * without the round trip through our parser having quietly normalised anything —
 * and a reference photo base64'd into a JSON document is a third bigger and
 * unreadable by every other tool on the machine.
 *
 * Everything here is pure: bytes in, bytes out, no filesystem and no Electron.
 * That is what lets the interesting half — a truncated file, a file from a
 * version that does not exist yet, a document that has been hand-edited into
 * nonsense — be tested headlessly instead of by clicking Open and hoping.
 *
 * ---------------------------------------------------------------------------
 * A loaded file is UNTRUSTED INPUT
 *
 * The same rule as restored window state in useWindowState, and for the same
 * reason, only with more at stake. This file survived an upgrade, or came from
 * someone else, or was edited by hand. So `unpackProject` refuses rather than
 * loads-and-hopes: a version it does not understand, a zip entry whose name
 * tries to escape the archive, a document whose tree does not hold together, a
 * node whose values are out of range. Every one of those is an exception with a
 * sentence explaining it, because "it opened but the outliner is empty" is a
 * much worse afternoon than "this file was saved by a newer version".
 * ---------------------------------------------------------------------------
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

import { DOCUMENT_VERSION, SIDE_STORES, pruneProject } from './document.js';
import { validateTree } from './tree.js';
import { validateDocument } from './schema.js';

/** The file extension, without the dot. */
export const EXTENSION = 'gollyg';

/** What the open and save dialogs should filter on. */
export const FILE_FILTER = Object.freeze({ name: 'GollyGCode project', extensions: [EXTENSION] });

/** Where each side store lives inside the archive. */
const LOCATION = Object.freeze({
	geometry: { entry: 'geometry.json', json: true },
	assets: { prefix: 'assets/', json: false },
	sources: { prefix: 'svg/', json: false },
});

/**
 * How to bring a project forward one version.
 *
 * Empty, because version 1 is the only version there has ever been. It exists
 * anyway, and `migrate` is wired up and tested through an injected table,
 * because the migration you need is always for files written before you thought
 * about migrations.
 *
 * A migration is keyed by the version it reads and returns the project one
 * version later. `migrate` sets the new version number itself.
 *
 * @type {Object<Number, Function>}
 */
export const MIGRATIONS = Object.freeze({});


/**
 * Brings a loaded project up to the current format version.
 *
 * @param {Object} raw - what came out of project.json
 * @param {Object} [migrations=MIGRATIONS] - the table, injectable for tests
 * @returns {Object} the project at {@link DOCUMENT_VERSION}
 * @throws {Error} when the version is missing, from the future, or unbridgeable
 */
export function migrate(raw, migrations = MIGRATIONS) {

	if (Number.isInteger(raw?.version) === false)
		throw new Error('This file has no format version, so it is not a GollyGCode project.');

	// The important half of having versions at all. A newer file may use fields
	// this build has never heard of, and loading the parts we recognise would
	// mean silently dropping the rest and then saving that back over it.
	if (raw.version > DOCUMENT_VERSION)
		throw new Error(
			`This file was saved by a newer version of GollyGCode (format ${raw.version}).`
			+ ` This build understands up to format ${DOCUMENT_VERSION}.`);

	let at = raw;

	while (at.version < DOCUMENT_VERSION) {

		const step = migrations[at.version];

		if (typeof step !== 'function')
			throw new Error(
				`This file is in format ${at.version} and there is no way to bring it forward`
				+ ` to format ${DOCUMENT_VERSION}.`);

		at = { ...step(at), version: at.version + 1 };
	}

	return at;
}


/**
 * Rejects an archive entry name that could write outside the archive.
 *
 * Zip slip: an entry called `../../../.bashrc` extracted naively lands where it
 * says rather than where it was put. Nothing here writes to disk, so this is
 * belt and braces — but a `.gollyg` is a file people send each other, and the
 * defence belongs at the point the name is read, not wherever it is used later.
 *
 * @param {String} name - the entry name
 * @throws {Error} when the name is not a plain relative path
 */
function checkEntryName(name) {

	if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split(/[/\\]/).includes('..'))
		throw new Error(`This file contains an entry with an unsafe name: ${name}`);
}


/**
 * Turns a project into the bytes of a `.gollyg` file.
 *
 * Prunes the side stores on the way through — this is the save, which is the one
 * moment it is safe to forget geometry nothing points at any more.
 *
 * @param {Object} project - the project
 * @param {Object} [options] - options
 * @param {String} [options.application] - what wrote it, for the file's own record
 * @param {Function} [options.now=Date.now] - the clock, injectable for tests
 * @returns {Uint8Array} the file
 * @throws {Error} when an SVG's name could not safely be an archive entry
 */
export function packProject(project, options = {}) {

	const { application = 'GollyGCode', now = Date.now } = options;
	const pruned = pruneProject(project);

	/** @type {Object<String, Uint8Array>} */
	const files = {
		'project.json': strToU8(JSON.stringify({
			version: DOCUMENT_VERSION,
			savedAt: new Date(now()).toISOString(),
			application,
			document: project.document,
		}, null, '\t')),
	};

	for (const { bucket } of SIDE_STORES) {

		const where = LOCATION[bucket];
		const entries = pruned[bucket];

		if (where.json === true) {
			files[where.entry] = strToU8(JSON.stringify(entries));
			continue;
		}

		for (const [key, value] of Object.entries(entries)) {
			checkEntryName(key);
			files[`${where.prefix}${key}`] = typeof value === 'string' ? strToU8(value) : value;
		}
	}

	// level 6 rather than 9: a project is mostly JSON, which is already most of
	// the way compressed at 6, and 9 costs several times the CPU for a percent
	return zipSync(files, { level: 6 });
}


/**
 * Reads the bytes of a `.gollyg` file back into a project.
 *
 * @param {Uint8Array} bytes - the file
 * @param {Object} [options] - options
 * @param {Object} [options.migrations=MIGRATIONS] - the migration table
 * @param {Boolean} [options.validate=true] - check the document holds together.
 *   Off only for a test that wants to inspect what a broken file produced
 * @returns {Object} the project, plus `savedAt` and `application` from the file
 * @throws {Error} when it is not a readable project, in one sentence
 */
export function unpackProject(bytes, options = {}) {

	const { migrations = MIGRATIONS, validate = true } = options;

	/** @type {Object<String, Uint8Array>} */
	let files;

	try {
		files = unzipSync(bytes);
	}
	catch (cause) {
		throw new Error('This is not a GollyGCode project file.', { cause });
	}

	for (const name of Object.keys(files))
		checkEntryName(name);

	if (files['project.json'] === undefined)
		throw new Error('This archive has no project.json, so it is not a GollyGCode project.');

	/** @type {Object} */
	let raw;

	try {
		raw = JSON.parse(strFromU8(files['project.json']));
	}
	catch (cause) {
		throw new Error('The project.json inside this file is damaged and cannot be read.', { cause });
	}

	const migrated = migrate(raw, migrations);

	if (migrated.document?.nodes === undefined || typeof migrated.document.root !== 'string')
		throw new Error('This file has no project tree in it.');

	/** @type {Object} */
	const project = {
		version: DOCUMENT_VERSION,
		document: migrated.document,
		savedAt: raw.savedAt ?? null,
		application: raw.application ?? null,
	};

	for (const { bucket } of SIDE_STORES) {

		const where = LOCATION[bucket];

		if (where.json === true) {
			project[bucket] = files[where.entry] === undefined
				? {}
				: readJson(files[where.entry], where.entry);
			continue;
		}

		project[bucket] = {};

		for (const [name, value] of Object.entries(files))
			if (name.startsWith(where.prefix) && name.length > where.prefix.length)
				project[bucket][name.slice(where.prefix.length)] =
					bucket === 'sources' ? strFromU8(value) : value;
	}

	if (validate)
		check(project);

	return project;
}

/**
 * Parses one JSON entry, blaming the entry rather than the whole file.
 *
 * @param {Uint8Array} bytes - the entry
 * @param {String} name - what it is called, for the message
 * @returns {Object} the parsed value
 * @throws {Error} when it will not parse
 */
function readJson(bytes, name) {

	try {
		return JSON.parse(strFromU8(bytes));
	}
	catch (cause) {
		throw new Error(`The ${name} inside this file is damaged and cannot be read.`, { cause });
	}
}

/**
 * Refuses a document that does not hold together.
 *
 * Shape first, then values, and it reports only the first few of each — a file
 * that fails this fails it comprehensively, and forty lines of detail is not
 * more useful than four.
 *
 * @param {Object} project - the loaded project
 * @throws {Error} listing what is wrong with it
 */
function check(project) {

	const shape = validateTree(project.document);

	if (shape.length > 0)
		throw new Error(`This project file is damaged:\n  ${shape.slice(0, 4).join('\n  ')}`);

	const values = validateDocument(project.document);

	if (values.length > 0)
		throw new Error(`This project file has settings that make no sense:\n  ${
			values.slice(0, 4).map((bad) => `${bad.id}: ${bad.issues[0]}`).join('\n  ')}`);
}


/**
 * A filename for a project, with the extension on it.
 *
 * @param {Object} project - the project
 * @returns {String} something safe to hand a save dialog
 */
export function suggestedFilename(project) {

	const name = project.document?.nodes?.[project.document.root]?.name ?? 'Untitled';
	const safe = name.replace(/[^\w \-.]/g, '').trim() || 'Untitled';

	return `${safe}.${EXTENSION}`;
}
