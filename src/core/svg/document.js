/**
 * @file document.js
 * @description Walks an SVG document and produces geometry in millimetres.
 *
 * This is where the SVG half of the core comes together: the viewport gives a
 * user-unit-to-millimetre matrix, ancestor transforms compose onto it, each
 * primitive becomes path data, and each path is normalized into subpaths flagged
 * open or closed. What comes out is ready for offsetting.
 *
 * The design rule throughout is that **nothing is dropped silently**. jscut's
 * habit of returning nothing when it does not understand an element — a nested
 * `<svg>` returns null with no message at all — is how a shape goes missing from
 * a cut without anybody noticing until the part is wrong. Everything skipped
 * here lands in `warnings` with a reason and enough identity to find it again.
 */

import { DOMParser } from '@xmldom/xmldom';
import { multiply, parseTransformList, fromTranslate } from './matrix.js';
import { resolveViewport } from './viewport.js';
import { elementToPathData, SUPPORTED_PRIMITIVES } from './primitives.js';
import { normalizePathData } from '../path/normalize.js';
import { computeStyle, parseStyleSheet, isHidden, fillRuleOf } from './style.js';

/** Elements whose children define reusable content and are not drawn in place. */
const NON_RENDERING_CONTAINERS = Object.freeze([
	'defs', 'symbol', 'clippath', 'mask', 'marker', 'pattern', 'lineargradient',
	'radialgradient', 'filter',
]);

/** Elements we skip without complaint, because they carry no geometry. */
const IGNORED_SILENTLY = Object.freeze([
	'title', 'desc', 'metadata', 'style', 'script', 'switch', 'view', 'animate',
	'animatetransform', 'animatemotion', 'set', 'mpath', 'font', 'font-face',
]);

/** Elements we skip loudly, because a user would expect them to produce a cut. */
const UNSUPPORTED_GEOMETRY = Object.freeze([
	'text', 'tspan', 'textpath', 'image', 'foreignobject',
]);

/** The SVG namespace. Anything else in the tree belongs to another vocabulary. */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** How deep `<use>` expansion may go before we call it a runaway. */
const MAX_USE_DEPTH = 16;


/**
 * Strips any namespace prefix and lowercases an element name.
 *
 * @param {Object} node - a DOM-like node
 * @returns {String} the local name, lowercased
 */
function localName(node) {

	return String(node.nodeName || '').replace(/^.*:/, '').toLowerCase();
}


/**
 * Iterates an element's child elements, skipping text and comment nodes.
 *
 * @param {Object} node - a DOM-like element
 * @yields {Object} each child element
 */
function* childElements(node) {

	for (let child = node.firstChild; child !== null; child = child.nextSibling) {
		if (child.nodeType === 1)
			yield child;
	}
}


/**
 * Concatenates the text content of a node.
 *
 * @param {Object} node - a DOM-like node
 * @returns {String} its text content
 */
function textContentOf(node) {

	let text = '';

	for (let child = node.firstChild; child !== null; child = child.nextSibling) {
		if (child.nodeType === 3 || child.nodeType === 4)
			text += child.data ?? '';
		else if (child.nodeType === 1)
			text += textContentOf(child);
	}

	return text;
}


/**
 * Parses SVG text into a document, failing loudly.
 *
 * @param {String} svgText - the raw document
 * @returns {Object} the root `<svg>` element
 * @throws {Error} when the text is not parseable, or is not an SVG
 */
export function parseSvgRoot(svgText) {

	if (typeof svgText !== 'string' || svgText.trim() === '')
		throw new Error('Empty SVG document');

	let doc;

	try {
		doc = new DOMParser({ onError: () => {} }).parseFromString(svgText, 'image/svg+xml');
	} catch (error) {
		throw new Error(`Could not parse SVG: ${error.message}`, { cause: error });
	}

	const root = doc?.documentElement;

	if (root === null || root === undefined)
		throw new Error('Could not parse SVG: no root element');

	if (localName(root) !== 'svg')
		throw new Error(`Expected an <svg> root, found <${localName(root)}>`);

	return root;
}


/**
 * Indexes every element carrying an `id`, so `<use>` can resolve references.
 *
 * @param {Object} root - the root element
 * @returns {Map<String, Object>} id to element
 */
function buildIdIndex(root) {

	const index = new Map();

	const visit = (node) => {

		const id = node.getAttribute('id');

		// first definition wins, as it does in a browser
		if (id !== null && id !== '' && index.has(id) === false)
			index.set(id, node);

		for (const child of childElements(node))
			visit(child);
	};

	visit(root);
	return index;
}


/**
 * Collects and parses every `<style>` element in the document.
 *
 * @param {Object} root - the root element
 * @returns {Object} `{ rules, warnings }`
 */
function collectStyleSheets(root) {

	let css = '';

	const visit = (node) => {
		if (localName(node) === 'style')
			css += `\n${textContentOf(node)}`;
		for (const child of childElements(node))
			visit(child);
	};

	visit(root);

	return css.trim() === '' ? { rules: [], warnings: [] } : parseStyleSheet(css);
}


/**
 * Resolves a `<use>` element's reference target.
 *
 * @param {Object} element - the use element
 * @returns {String|null} the referenced id, without its hash
 */
function useTargetId(element) {

	const href = element.getAttribute('href') ?? element.getAttribute('xlink:href');

	if (typeof href !== 'string' || href.startsWith('#') === false)
		return null;

	return href.slice(1);
}


/**
 * Imports an SVG document into millimetre-space geometry.
 *
 * @param {String} svgText - the raw SVG document
 * @param {Object} [options] - options
 * @param {Number} [options.coincidenceTolerance] - forwarded to path normalization
 * @param {Number} [options.pixelsPerInch] - resolution assumed for unitless sizes;
 *   see viewport.js. Ignored when the document states a real physical unit.
 * @returns {Object} `{ viewport, shapes, warnings }`
 * @throws {Error} when the document cannot be parsed at all
 */
export function importSvgDocument(svgText, options = {}) {

	const root = parseSvgRoot(svgText);
	const viewport = resolveViewport(root, options.pixelsPerInch === undefined
		? {}
		: { pixelsPerInch: options.pixelsPerInch });

	const idIndex = buildIdIndex(root);
	const sheets = collectStyleSheets(root);

	/** @type {String[]} */
	const warnings = [...viewport.warnings, ...sheets.warnings];

	/** @type {Array<Object>} */
	const shapes = [];

	/** Counts per tag name, so unnamed shapes get stable readable labels. */
	const tagCounts = new Map();

	/**
	 * Builds a human label for a shape, preferring the author's own id.
	 *
	 * @param {Object} element - the geometry element
	 * @param {String} tag - its local name
	 * @returns {String} a label for the outliner
	 */
	const labelFor = (element, tag) => {

		const id = element.getAttribute('id');
		if (id !== null && id !== '')
			return id;

		const next = (tagCounts.get(tag) ?? 0) + 1;
		tagCounts.set(tag, next);
		return `${tag} ${next}`;
	};

	/**
	 * Recursively walks the tree, accumulating transforms and styles.
	 *
	 * @param {Object} node - the element to visit
	 * @param {Number[]} parentMatrix - the composed transform above this node
	 * @param {Object} inheritedStyle - the parent's computed style
	 * @param {String[]} useStack - ids currently being expanded, for cycle detection
	 * @returns {void}
	 */
	const walk = (node, parentMatrix, inheritedStyle, useStack) => {

		const tag = localName(node);

		// Elements from another vocabulary -- Inkscape's sodipodi:namedview, RDF
		// metadata, Adobe's private tags -- are not geometry and never will be.
		// Testing the namespace rather than collecting tag names by hand means we
		// do not have to keep up with whatever the next editor decides to emit.
		if (node.namespaceURI && node.namespaceURI !== SVG_NAMESPACE)
			return;

		if (IGNORED_SILENTLY.includes(tag))
			return;

		// content inside <defs>, <symbol> and friends is only drawn via <use>
		if (NON_RENDERING_CONTAINERS.includes(tag) && useStack.length === 0)
			return;

		const style = computeStyle(node, inheritedStyle, sheets.rules);

		if (isHidden(style)) {
			// hidden is a deliberate authoring choice, not a problem to report
			return;
		}

		let matrix;

		try {
			matrix = multiply(parentMatrix, parseTransformList(node.getAttribute('transform')));
		} catch (error) {
			warnings.push(`<${tag}${identify(node)}>: ${error.message} — element skipped`);
			return;
		}

		// ---- <use>: expand the referenced subtree in place -----------------
		if (tag === 'use') {

			const targetId = useTargetId(node);

			if (targetId === null) {
				warnings.push(`<use${identify(node)}> has no usable href — skipped`);
				return;
			}

			const target = idIndex.get(targetId);

			if (target === undefined) {
				warnings.push(`<use${identify(node)}> references missing id "${targetId}" — skipped`);
				return;
			}

			if (useStack.includes(targetId)) {
				warnings.push(`<use> reference cycle through "${targetId}" — skipped`);
				return;
			}

			if (useStack.length >= MAX_USE_DEPTH) {
				warnings.push(`<use> nesting deeper than ${MAX_USE_DEPTH} — skipped`);
				return;
			}

			// x and y on <use> are shorthand for a translate applied inside it
			const x = Number.parseFloat(node.getAttribute('x') ?? '0') || 0;
			const y = Number.parseFloat(node.getAttribute('y') ?? '0') || 0;
			const placed = multiply(matrix, fromTranslate(x, y));

			if (localName(target) === 'symbol' && target.getAttribute('viewBox') !== null)
				warnings.push(`<use> targets <symbol id="${targetId}"> with its own viewBox, which is not applied`);

			walk(target, placed, style, [...useStack, targetId]);
			return;
		}

		// ---- containers -----------------------------------------------------
		if (tag === 'g' || tag === 'a' || tag === 'symbol'
			|| NON_RENDERING_CONTAINERS.includes(tag)) {

			for (const child of childElements(node))
				walk(child, matrix, style, useStack);

			return;
		}

		// ---- nested <svg> ---------------------------------------------------
		if (tag === 'svg') {

			if (node !== root) {
				// a nested svg establishes its own viewport, which we do not model
				warnings.push(
					`Nested <svg${identify(node)}> is treated as a group; its own `
					+ 'viewBox and clipping are not applied',
				);
			}

			for (const child of childElements(node))
				walk(child, matrix, style, useStack);

			return;
		}

		// ---- things a user would expect to cut, but we cannot yet -----------
		if (UNSUPPORTED_GEOMETRY.includes(tag)) {
			warnings.push(
				`<${tag}${identify(node)}> is not supported yet — convert it to a path `
				+ 'in your editor and re-export',
			);
			return;
		}

		// ---- geometry --------------------------------------------------------
		if (SUPPORTED_PRIMITIVES.includes(tag)) {

			let pathData;

			try {
				pathData = elementToPathData(node);
			} catch (error) {
				warnings.push(`<${tag}${identify(node)}>: ${error.message}`);
				return;
			}

			if (pathData === null) {
				// degenerate geometry draws nothing; the spec says so, and silently
				// skipping it matches every renderer
				return;
			}

			let normalized;

			try {
				normalized = normalizePathData(pathData, {
					matrix,
					coincidenceTolerance: options.coincidenceTolerance,
				});
			} catch (error) {
				warnings.push(`<${tag}${identify(node)}>: ${error.message} — skipped`);
				return;
			}

			for (const warning of normalized.warnings)
				warnings.push(`<${tag}${identify(node)}>: ${warning}`);

			if (normalized.subPaths.length === 0)
				return;

			shapes.push({
				id: node.getAttribute('id') || null,
				label: labelFor(node, tag),
				tag,
				subPaths: normalized.subPaths,
				fillRule: fillRuleOf(style),
				style: {
					fill: style.fill ?? null,
					stroke: style.stroke ?? null,
					strokeWidth: style['stroke-width'] ?? null,
				},
			});

			return;
		}

		// ---- anything else ----------------------------------------------------
		warnings.push(`Unrecognized element <${tag}${identify(node)}> — skipped`);
	};

	walk(root, viewport.matrix, {}, []);

	return { viewport, shapes, warnings };
}


/**
 * Formats an element's id for a warning message, if it has one.
 *
 * @param {Object} node - a DOM-like element
 * @returns {String} ` id="..."`, or an empty string
 */
function identify(node) {

	const id = node.getAttribute('id');
	return (id !== null && id !== '') ? ` id="${id}"` : '';
}


/**
 * Counts open subpaths across every imported shape.
 *
 * The UI needs this to decide which operations to offer: an open path has no
 * inside or outside, so it gets the offset and path-normal operations instead.
 *
 * @param {Array<Object>} shapes - shapes from `importSvgDocument`
 * @returns {Object} `{ open, closed }` counts
 */
export function countSubPathKinds(shapes) {

	let open = 0;
	let closed = 0;

	for (const shape of shapes) {
		for (const subPath of shape.subPaths) {
			if (subPath.closed)
				closed++;
			else
				open++;
		}
	}

	return { open, closed };
}
