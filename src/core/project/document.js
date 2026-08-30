/**
 * @file document.js
 * @description Making a new project, and the shape of the thing on disk.
 *
 * A project is three parts, deliberately separate:
 *
 *   `document`  the node tree, the selection. Small, plain, and the ONLY thing
 *               the undo history ever copies.
 *   `geometry`  path data, keyed by id and never modified in place. Large.
 *   `version`   what the format was when this was written, so 3.4 has something
 *               to migrate from.
 *
 * The split is the important part. Undo works by copying the subtrees a command
 * touches; if a 40,000-point path lived inside its SvgPath node, renaming that
 * path would copy all 40,000 numbers twice. Because geometry is immutable and
 * referenced by id, a command that replaces it points the node at a new id — and
 * undo restoring the old id restores the old geometry with it, at no cost.
 *
 * The corollary is that geometry accumulates. Entries nothing refers to any more
 * are dropped on save (3.4), not on undo, because the entry an undo just orphaned
 * is exactly the one a redo will want back.
 */

import { NodeType, FolderRole, createNode } from './nodes.js';

/**
 * The format version.
 *
 * Bumped when the shape of a saved project changes in a way an older reader
 * would get wrong. Present from the first version so that there is never a file
 * without one — the migration problem nobody has yet is much easier than the one
 * where half the files are unlabelled.
 */
export const DOCUMENT_VERSION = 1;


/**
 * @typedef {Object} Project
 * @property {Number} version - {@link DOCUMENT_VERSION} at the time of writing
 * @property {Object} document - `{ root, nodes, selection }`, the undoable part
 * @property {Object} geometry - path data by id, immutable, not undoable
 * @property {Object} assets - reference images by id, as bytes
 * @property {Object} sources - imported SVG files by name, kept verbatim so they
 *   stay re-importable
 */


/**
 * The three side stores, and the node field that points into each.
 *
 * One table so that pruning, packing and unpacking cannot disagree about how
 * many of these there are — adding a fourth is a line here, not a search.
 *
 * @type {Array<{bucket: String, field: String}>}
 */
export const SIDE_STORES = Object.freeze([
	{ bucket: 'geometry', field: 'geometry' },
	{ bucket: 'assets', field: 'asset' },
	{ bucket: 'sources', field: 'source' },
]);


/**
 * Makes an empty project: a Project node and its three fixed folders.
 *
 * No Tool is created. The first job makes one (3.5), because a tool group with
 * nothing in it is a thing to explain rather than a thing to use.
 *
 * @param {Object} [options] - options
 * @param {String} [options.name='Untitled'] - the project's name
 * @param {Function} [options.newId] - id factory, injectable so tests are deterministic
 * @returns {Project} a new project
 */
export function createProject(options = {}) {

	const { name = 'Untitled', newId } = options;
	const make = (type, props) => createNode(type, props, { newId });

	const root = make(NodeType.PROJECT, { name });

	const folders = [
		make(NodeType.FOLDER, { name: 'Jobs', role: FolderRole.JOBS }),
		make(NodeType.FOLDER, { name: 'SVGs', role: FolderRole.SVGS }),
		make(NodeType.FOLDER, { name: 'References', role: FolderRole.REFERENCES }),
	];

	root.children = folders.map((folder) => folder.id);

	/** @type {Object<String, Object>} */
	const nodes = { [root.id]: root };

	for (const folder of folders)
		nodes[folder.id] = folder;

	return {
		version: DOCUMENT_VERSION,
		document: {
			root: root.id,
			nodes,
			selection: { active: root.id, ids: [root.id] },
		},
		geometry: {},
		assets: {},
		sources: {},
	};
}


/**
 * Which keys of one side store are still referred to by a node.
 *
 * @param {Object} document - the project document
 * @param {String} field - the node field that points into it
 * @returns {Set<String>} the live keys
 */
export function referenced(document, field) {

	/** @type {Set<String>} */
	const live = new Set();

	for (const node of Object.values(document.nodes))
		if (typeof node[field] === 'string' && node[field] !== '')
			live.add(node[field]);

	return live;
}


/**
 * Drops everything in the side stores that nothing points at any more.
 *
 * For SAVE, and only for save. Doing it after an undo would throw away exactly
 * what the matching redo needs, and doing it on a timer would make undo depend
 * on how long you happened to pause.
 *
 * @param {Project} project - the project
 * @returns {Object} `{ geometry, assets, sources, dropped }` — the kept entries
 *   and, per bucket, the keys removed
 */
export function pruneProject(project) {

	/** @type {Object} */
	const kept = {};

	/** @type {Object<String, String[]>} */
	const dropped = {};

	for (const { bucket, field } of SIDE_STORES) {

		const live = referenced(project.document, field);

		kept[bucket] = {};
		dropped[bucket] = [];

		for (const [key, value] of Object.entries(project[bucket] ?? {}))
			if (live.has(key))
				kept[bucket][key] = value;
			else
				dropped[bucket].push(key);
	}

	return { ...kept, dropped };
}
