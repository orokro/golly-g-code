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
