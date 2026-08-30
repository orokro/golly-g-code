/**
 * @file index.js
 * @description Public barrel for the CAM core.
 *
 * Everything the application layer is allowed to use from `src/core` is
 * re-exported here. Importing a module by its deep path from outside the core is
 * a smell — it means the boundary is leaking.
 *
 * See CONVENTIONS.md for the rules this subtree lives by. The short version:
 * millimetres, Y-up, radians, no Vue, no DOM, no silent failures.
 */

export {
	MM_PER_INCH,
	Unit,
	toMillimeters,
	fromMillimeters,
	convert,
	parseLength,
	formatLength,
	formatFractionalInches,
	feedToMillimetersPerMinute,
	feedFromMillimetersPerMinute,
} from './units/units.js';

export {
	createHistory,
	DEFAULT_LIMIT,
	DEFAULT_COALESCE_WINDOW_MS,
} from './project/history.js';

export {
	nodeDriver,
	cloneData,
	capture,
	restore,
	cloneState,
	diffStates,
	reachable,
} from './project/snapshot.js';

export {
	NodeType,
	FolderRole,
	Kind,
	Quantity,
	Combine,
	ToolChange,
	JobOperation,
	FIELDS,
	ALLOWED_CHILDREN,
	ORDERED_ROLES,
	fieldsOf,
	fieldSpec,
	createNode,
} from './project/nodes.js';

export {
	DOCUMENT_VERSION,
	SIDE_STORES,
	createProject,
	referenced,
	pruneProject,
} from './project/document.js';

export {
	EXTENSION,
	FILE_FILTER,
	MIGRATIONS,
	migrate,
	packProject,
	unpackProject,
	suggestedFilename,
} from './project/file.js';

export {
	parentIndex,
	parentOf,
	childrenOf,
	ancestorsOf,
	ancestorOfType,
	descendantsOf,
	isVisible,
	isLocked,
	folderOf,
	cuttingOrder,
	validateTree,
} from './project/tree.js';

export {
	Source,
	resolveField,
	resolveNode,
	resolvedValues,
	overridesOf,
	dependentsOf,
} from './project/inherit.js';

export {
	SCHEMAS,
	validateNode,
	validateDocument,
	validateValue,
} from './project/schema.js';

export {
	Level,
	DepthClass,
	DEPTH_EPSILON,
	classifyDepth,
	diagnose,
	blocksExport,
	byNode,
} from './project/diagnostics.js';

export {
	prepareSvgImport,
	uniqueName,
	summarise,
} from './project/import.js';

export {
	setField,
	clearOverride,
	addNode,
	addSubtree,
	removeNode,
	moveNode,
	reorderChildren,
	setReferences,
} from './project/commands.js';
