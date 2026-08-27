/**
 * @file style.js
 * @description Just enough CSS to read an SVG correctly.
 *
 * Illustrator's default export preset puts presentation properties in an
 * internal stylesheet rather than on the elements — `<style>.st0{fill:none;}</style>`
 * with `class="st0"` on the shapes. jscut ignores stylesheets entirely, and for
 * fill and stroke that only costs you the wrong preview colour. But `display:none`
 * in a class means importing shapes the artwork does not draw, which is a
 * correctness problem, not a cosmetic one.
 *
 * So: simple selectors only — `tag`, `.class`, `#id`, and comma-separated lists
 * of those. No combinators, no pseudo-classes, no media queries, no attribute
 * selectors. Anything more exotic is reported as a warning rather than silently
 * half-applied, because a rule we pretend to understand is worse than one we
 * admit we skipped.
 *
 * The cascade order implemented here is the one CSS specifies for SVG:
 * presentation attributes lose to stylesheet rules, which lose to a `style`
 * attribute.
 */

/** Properties that inherit from parent to child in SVG. */
export const INHERITED_PROPERTIES = Object.freeze([
	'fill', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
	'stroke-linejoin', 'visibility', 'color',
]);

/** Presentation attributes we bother reading off elements. */
export const PRESENTATION_ATTRIBUTES = Object.freeze([
	...INHERITED_PROPERTIES, 'display', 'opacity',
]);

/** Specificity weights, enough to order the selectors we support. */
const SPECIFICITY = Object.freeze({ tag: 1, class: 10, id: 100 });


/**
 * Parses a `style` attribute or a declaration block into a plain object.
 *
 * @param {String|null|undefined} text - declarations, e.g. `fill:none;stroke:#000`
 * @returns {Object} property/value pairs, lowercased property names
 */
export function parseDeclarations(text) {

	const result = {};

	if (text === null || text === undefined)
		return result;

	for (const chunk of String(text).split(';')) {

		const index = chunk.indexOf(':');
		if (index < 0)
			continue;

		const property = chunk.slice(0, index).trim().toLowerCase();
		const value = chunk.slice(index + 1).trim();

		// strip !important; we have no cascade layer where it would change anything
		if (property !== '' && value !== '')
			result[property] = value.replace(/\s*!important\s*$/i, '');
	}

	return result;
}


/**
 * Parses the contents of `<style>` elements into matchable rules.
 *
 * @param {String} css - raw stylesheet text
 * @returns {Object} `{ rules, warnings }`
 */
export function parseStyleSheet(css) {

	/** @type {Array<Object>} */
	const rules = [];

	/** @type {String[]} */
	const warnings = [];

	// drop comments first so they cannot hide braces from us
	const text = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');

	// at-rules (@media, @import, @font-face) carry nested or external context we
	// do not model; skipping the whole block is safer than misreading its inside
	if (/@\w+/.test(text))
		warnings.push('Stylesheet contains at-rules (@media, @import, …), which are ignored');

	const blockPattern = /([^{}]+)\{([^{}]*)\}/g;

	let match = blockPattern.exec(text);
	while (match !== null) {

		const selectorList = match[1].trim();
		const declarations = parseDeclarations(match[2]);

		if (selectorList.startsWith('@') === false && Object.keys(declarations).length > 0) {

			for (const rawSelector of selectorList.split(',')) {

				const selector = rawSelector.trim();
				if (selector === '')
					continue;

				const parsed = parseSimpleSelector(selector);

				if (parsed === null) {
					warnings.push(`Unsupported CSS selector "${selector}", ignored`);
					continue;
				}

				rules.push({ ...parsed, declarations, order: rules.length });
			}
		}

		match = blockPattern.exec(text);
	}

	return { rules, warnings };
}


/**
 * Parses one simple selector.
 *
 * @param {String} selector - a single selector, already trimmed
 * @returns {Object|null} `{ kind, name, specificity }`, or null if unsupported
 */
function parseSimpleSelector(selector) {

	if (selector === '*')
		return { kind: 'universal', name: '*', specificity: 0 };

	if (/^[.][A-Za-z_][\w-]*$/.test(selector))
		return { kind: 'class', name: selector.slice(1), specificity: SPECIFICITY.class };

	if (/^#[A-Za-z_][\w-]*$/.test(selector))
		return { kind: 'id', name: selector.slice(1), specificity: SPECIFICITY.id };

	if (/^[A-Za-z][\w-]*$/.test(selector))
		return { kind: 'tag', name: selector.toLowerCase(), specificity: SPECIFICITY.tag };

	return null;
}


/**
 * Whether a rule matches an element.
 *
 * @param {Object} rule - a parsed rule
 * @param {String} tagName - the element's local name, lowercased
 * @param {String|null} id - the element's id attribute
 * @param {String[]} classes - the element's class list
 * @returns {Boolean} true when the rule applies
 */
function ruleMatches(rule, tagName, id, classes) {

	switch (rule.kind) {
		case 'universal': return true;
		case 'tag': return rule.name === tagName;
		case 'id': return rule.name === id;
		case 'class': return classes.includes(rule.name);
		default: return false;
	}
}


/**
 * Computes an element's style, applying the SVG cascade.
 *
 * Order, lowest priority first: inherited values, presentation attributes,
 * matching stylesheet rules by specificity then document order, and finally the
 * `style` attribute.
 *
 * @param {Object} element - a DOM-like element
 * @param {Object} inherited - the parent's computed style
 * @param {Array<Object>} rules - parsed stylesheet rules
 * @returns {Object} the computed style for this element
 */
export function computeStyle(element, inherited, rules) {

	const computed = {};

	// only inheritable properties come down from the parent
	for (const property of INHERITED_PROPERTIES) {
		if (inherited[property] !== undefined)
			computed[property] = inherited[property];
	}

	const tagName = String(element.nodeName || '').replace(/^.*:/, '').toLowerCase();
	const id = element.getAttribute('id');
	const classes = String(element.getAttribute('class') || '')
		.split(/\s+/)
		.filter((token) => token !== '');

	// presentation attributes: lowest priority of anything on the element itself
	for (const property of PRESENTATION_ATTRIBUTES) {
		const value = element.getAttribute(property);
		if (value !== null && value !== '')
			computed[property] = value;
	}

	// stylesheet rules, weakest first so stronger ones overwrite
	const matched = rules
		.filter((rule) => ruleMatches(rule, tagName, id, classes))
		.sort((a, b) => (a.specificity - b.specificity) || (a.order - b.order));

	for (const rule of matched)
		Object.assign(computed, rule.declarations);

	// the style attribute wins over everything above it
	Object.assign(computed, parseDeclarations(element.getAttribute('style')));

	return computed;
}


/**
 * Whether a computed style means the element is not drawn.
 *
 * @param {Object} style - a computed style
 * @returns {Boolean} true when the element should be skipped
 */
export function isHidden(style) {

	return style.display === 'none'
		|| style.visibility === 'hidden'
		|| style.visibility === 'collapse';
}


/**
 * Reads the fill rule from a computed style.
 *
 * @param {Object} style - a computed style
 * @returns {String} `'evenodd'` or `'nonzero'`
 */
export function fillRuleOf(style) {

	return String(style['fill-rule'] ?? '').toLowerCase() === 'evenodd' ? 'evenodd' : 'nonzero';
}
