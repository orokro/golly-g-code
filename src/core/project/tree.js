/**
 * @file tree.js
 * @description Reading the shape of a project.
 *
 * The document stores the tree once, as `children` arrays. Everything anyone
 * else wants to know about the shape — who a node's parent is, which Tool a Job
 * belongs to, whether something is really visible — is derived here rather than
 * stored, because a second copy of the tree is a second thing to keep correct
 * and it is the copy that quietly goes wrong.
 *
 * Deriving a parent means a scan. For a document of a few thousand nodes that is
 * nothing, and every function here takes an optional prebuilt index for the
 * places where it would not be — walking every job to emit a program, say.
 */

import { reachable } from './snapshot.js';
import { NodeType, Kind, FIELDS, ALLOWED_CHILDREN } from './nodes.js';

/**
 * Maps every node to its parent.
 *
 * Build this once and pass it in when asking about many nodes at a time.
 *
 * @param {Object} document - the project document
 * @returns {Map<String, String>} child id to parent id; the root is absent
 */
export function parentIndex(document) {

	/** @type {Map<String, String>} */
	const parents = new Map();

	for (const node of Object.values(document.nodes))
		for (const child of node.children ?? [])
			parents.set(child, node.id);

	return parents;
}


/**
 * A node's parent.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node
 * @param {Map<String, String>} [index] - a prebuilt {@link parentIndex}
 * @returns {Object|null} the parent node, or null for the root or an unknown id
 */
export function parentOf(document, id, index = parentIndex(document)) {

	const parent = index.get(id);

	return parent === undefined ? null : document.nodes[parent] ?? null;
}


/**
 * A node's children, as nodes.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node
 * @returns {Object[]} the children in order, skipping any dangling id
 */
export function childrenOf(document, id) {

	return (document.nodes[id]?.children ?? [])
		.map((child) => document.nodes[child])
		.filter((child) => child !== undefined);
}


/**
 * Every ancestor, nearest first.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node
 * @param {Map<String, String>} [index] - a prebuilt {@link parentIndex}
 * @returns {Object[]} the ancestors, ending at the root
 */
export function ancestorsOf(document, id, index = parentIndex(document)) {

	/** @type {Object[]} */
	const found = [];

	/** @type {Set<String>} guards a malformed cycle rather than hanging */
	const seen = new Set([id]);

	let current = index.get(id);

	while (current !== undefined && seen.has(current) === false) {
		seen.add(current);
		const node = document.nodes[current];
		if (node === undefined)
			break;
		found.push(node);
		current = index.get(current);
	}

	return found;
}


/**
 * The nearest ancestor of a given type.
 *
 * This is how a Job finds its Tool and how a Tab finds its Job — and, through
 * them, how live-linked inheritance resolves.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node to start from
 * @param {String} type - one of {@link NodeType}
 * @param {Map<String, String>} [index] - a prebuilt {@link parentIndex}
 * @returns {Object|null} the ancestor, or null when there is none
 */
export function ancestorOfType(document, id, type, index = parentIndex(document)) {
	return ancestorsOf(document, id, index).find((node) => node.type === type) ?? null;
}


/**
 * Every id in a node's subtree, including its own.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node
 * @returns {String[]} the ids
 */
export function descendantsOf(document, id) {
	return [...reachable(document, id)];
}


/**
 * Whether a node is actually drawn.
 *
 * Visibility is inherited downwards: hiding the Jobs folder hides every job in
 * it, without touching any of their own flags, so unhiding the folder brings
 * back exactly what was showing before.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node
 * @param {Map<String, String>} [index] - a prebuilt {@link parentIndex}
 * @returns {Boolean} true when it and all of its ancestors are visible
 */
export function isVisible(document, id, index = parentIndex(document)) {

	const node = document.nodes[id];

	if (node === undefined)
		return false;

	return node.visible !== false
		&& ancestorsOf(document, id, index).every((a) => a.visible !== false);
}


/**
 * Whether a node can be picked or dragged.
 *
 * Inherited downwards, same as visibility: locking a folder locks its contents.
 *
 * @param {Object} document - the project document
 * @param {String} id - the node
 * @param {Map<String, String>} [index] - a prebuilt {@link parentIndex}
 * @returns {Boolean} true when it or any ancestor is locked
 */
export function isLocked(document, id, index = parentIndex(document)) {

	const node = document.nodes[id];

	if (node === undefined)
		return true;

	return node.locked === true
		|| ancestorsOf(document, id, index).some((a) => a.locked === true);
}


/**
 * The folder with a given role.
 *
 * @param {Object} document - the project document
 * @param {String} role - one of {@link FolderRole}
 * @returns {Object|null} the folder node
 */
export function folderOf(document, role) {

	return childrenOf(document, document.root)
		.find((node) => node.type === NodeType.FOLDER && node.role === role) ?? null;
}


/**
 * Every job, in the order the machine will cut them.
 *
 * Tree order IS emission order (D7), so this is a straight depth-first walk of
 * the Jobs folder rather than anything that sorts or optimises. Tool boundaries
 * come out as tool changes because the tools are the level above.
 *
 * @param {Object} document - the project document
 * @returns {Object[]} `{ tool, job }` pairs, in cutting order
 */
export function cuttingOrder(document) {

	const jobs = folderOf(document, 'jobs');

	if (jobs === null)
		return [];

	return childrenOf(document, jobs.id)
		.filter((tool) => tool.type === NodeType.TOOL)
		.flatMap((tool) => childrenOf(document, tool.id)
			.filter((job) => job.type === NodeType.JOB)
			.map((job) => ({ tool, job })));
}


/**
 * Everything structurally wrong with a document.
 *
 * Not a validator of VALUES — schema.js does that. This is about the shape:
 * children that do not exist, nodes nothing points at, a cycle, a Job that has
 * escaped its Tool. All of these are impossible if every mutation went through a
 * command, which is exactly why it is worth being able to prove it after loading
 * a file somebody hand-edited.
 *
 * @param {Object} document - the project document
 * @returns {String[]} descriptions, empty when the shape is sound
 */
export function validateTree(document) {

	/** @type {String[]} */
	const issues = [];
	const root = document.nodes[document.root];

	if (root === undefined)
		return [`the root "${document.root}" is not in the document`];

	if (root.type !== NodeType.PROJECT)
		issues.push(`the root is a ${root.type}, not a ${NodeType.PROJECT}`);

	/** @type {Map<String, String[]>} how many parents each node has */
	const claims = new Map();

	for (const node of Object.values(document.nodes)) {

		const allowed = ALLOWED_CHILDREN[node.type];

		if (allowed === undefined) {
			issues.push(`${label(node)} has an unknown type "${node.type}"`);
			continue;
		}

		for (const childId of node.children ?? []) {

			claims.set(childId, [...(claims.get(childId) ?? []), node.id]);

			const child = document.nodes[childId];

			if (child === undefined) {
				issues.push(`${label(node)} lists a child "${childId}" that is not in the document`);
				continue;
			}

			if (allowed.includes(child.type) === false)
				issues.push(`${label(node)} may not contain a ${child.type} (${label(child)})`);
		}
	}

	for (const [id, parents] of claims)
		if (parents.length > 1)
			issues.push(`${label(document.nodes[id])} is claimed as a child by ${parents.length} nodes`);

	const attached = reachable(document, document.root);

	for (const id of Object.keys(document.nodes))
		if (attached.has(id) === false)
			issues.push(`${label(document.nodes[id])} is not reachable from the root`);

	for (const node of Object.values(document.nodes))
		for (const [field, spec] of Object.entries(FIELDS[node.type] ?? {}))
			if (spec.kind === Kind.REFERENCES)
				for (const target of node[field] ?? [])
					if (document.nodes[target] === undefined)
						issues.push(`${label(node)} refers to "${target}" in ${field}, which is not in the document`);

	for (const id of [document.selection?.active, ...(document.selection?.ids ?? [])])
		if (id != null && document.nodes[id] === undefined)
			issues.push(`the selection refers to "${id}", which is not in the document`);

	return issues;
}

/**
 * Names a node for a message.
 *
 * @param {Object} node - the node
 * @returns {String} something a human can find in the outliner
 */
function label(node) {
	return node === undefined ? 'an unknown node' : `${node.type} "${node.name}" (${node.id})`;
}
