/**
 * @file nodes.js
 * @description What a project is made of, and what each piece is allowed to hold.
 *
 * One table, `FIELDS`, is the single description of every settable property in
 * the application. It drives four things that would otherwise drift apart:
 *
 *   1. the defaults a new node is created with,
 *   2. the Valibot schema that validates it (schema.js),
 *   3. which fields fall back to an ancestor's value (inherit.js),
 *   4. what the Inspector renders, and with which control (3.6).
 *
 * jscut is the cautionary tale: six independent unit dropdowns and a
 * `makeAllSameUnit()` to paper over them. Every one of those was a place the
 * same fact was written down twice.
 *
 * ---------------------------------------------------------------------------
 * Two things deliberately NOT in the node tree
 *
 * `parent`. The tree is `children` arrays and nothing else. A `parent` field
 * would be the same fact stored twice, and every reorder would have to update
 * both or leave the document quietly inconsistent. Where the parent is needed,
 * `tree.js` derives it.
 *
 * Geometry. An SvgPath node holds a `geometry` id, not points. Toolpath and path
 * data is tens of thousands of numbers, and the undo system copies the subtrees
 * a command touches — putting points in a node would mean cloning a whole SVG's
 * worth of coordinates to record that its name changed. Geometry lives beside
 * the document, immutable and content-keyed, where the history never sees it:
 * changing it means pointing the node at a new id, which undo restores for free.
 * ---------------------------------------------------------------------------
 */

import { DEFAULT_RAMP_ANGLE } from '../cam/entry.js';
import { Operation, Direction } from '../cam/operations.js';
import { OpenMode, Side } from '../cam/openOffset.js';

/** The kinds of node a project can contain. */
export const NodeType = Object.freeze({
	PROJECT: 'Project',
	FOLDER: 'Folder',
	TOOL: 'Tool',
	JOB: 'Job',
	TAB: 'Tab',
	SVG_DOC: 'SvgDoc',
	SVG_PATH: 'SvgPath',
	REFERENCE_IMAGE: 'ReferenceImage',
	WORK_MATERIAL: 'WorkMaterial',
});

/** The three fixed folders under a project. */
export const FolderRole = Object.freeze({
	JOBS: 'jobs',
	SVGS: 'svgs',
	REFERENCES: 'references',
});

/** What control the Inspector should draw for a field. */
export const Kind = Object.freeze({
	NUMBER: 'number',
	TEXT: 'text',
	BOOLEAN: 'boolean',
	SELECT: 'select',
	VECTOR2: 'vector2',

	/**
	 * A list of ids of OTHER NODES — a job's source paths, say.
	 *
	 * Ids and not embedded copies, so editing a path moves every job cut from
	 * it. The cost is that they can dangle when the target is deleted, which is
	 * why `validateTree` checks them.
	 */
	REFERENCES: 'references',
});

/**
 * What a field measures.
 *
 * Separate from `Unit` in core/units, which is a DISPLAY unit — millimetres or
 * inches. This says what sort of number it is, which decides whether the display
 * unit applies to it at all: a spindle speed is not shorter in inches.
 *
 * Per CONVENTIONS.md, `ANGLE` is radians internally and degrees only in the UI.
 */
export const Quantity = Object.freeze({
	LENGTH: 'length',
	FEED: 'feed',
	ANGLE: 'angle',
	RPM: 'rpm',
	FRACTION: 'fraction',
	COUNT: 'count',
	SECONDS: 'seconds',
	NONE: 'none',
});

/** How a job may be combined with the others selected alongside it. */
export const Combine = Object.freeze({
	NONE: 'none',
	UNION: 'union',
	INTERSECT: 'intersect',
	DIFFERENCE: 'difference',
	XOR: 'xor',
});

/** Whether the machine can change its own tool between groups. */
export const ToolChange = Object.freeze({
	MANUAL: 'manual',
	AUTOMATIC: 'automatic',
});

/**
 * Everything a job can be asked to do.
 *
 * The closed-path operations and the open-path modes in one list, because a job
 * has one operation and the source path decides which half is meaningful.
 * `center` is in both and means the same thing in both: the tool centre on the
 * line. Choosing `pocket` for an open path is not an error the data model can
 * prevent — it is a diagnostic (diagnostics.js) and a filtered list of options
 * in the Inspector.
 */
export const JobOperation = Object.freeze({ ...Operation, ...OpenMode });


/**
 * @typedef {Object} FieldSpec
 * @property {String} label - what the Inspector calls it
 * @property {String} desc - the longer explanation
 * @property {String} kind - one of {@link Kind}
 * @property {String} quantity - one of {@link Quantity}
 * @property {*} default - the value a new node starts with
 * @property {Number} [min] - smallest accepted value
 * @property {Number} [max] - largest accepted value
 * @property {Number} [step] - Inspector increment
 * @property {String[]} [options] - the permitted values, for a Select
 * @property {Object} [inherit] - `{ from, field }`: the ancestor node type to
 *   fall back to, and the field on it. Live-linked, never copied
 * @property {Boolean} [physical] - a fact about the object, not a preference, so
 *   it is never overridable. A two-flute cutter has two flutes
 */

/** Fields every node carries, whatever it is. */
const COMMON = Object.freeze({

	name: {
		label: 'Name', desc: 'What it is called in the outliner.',
		kind: Kind.TEXT, quantity: Quantity.NONE, default: '',
	},

	locked: {
		label: 'Locked', desc: 'Locked items cannot be selected or dragged in the workspace.',
		kind: Kind.BOOLEAN, quantity: Quantity.NONE, default: false,
	},

	visible: {
		label: 'Visible', desc: 'Hidden items are not drawn. Hiding a folder hides everything in it.',
		kind: Kind.BOOLEAN, quantity: Quantity.NONE, default: true,
	},
});


/**
 * Every settable field, by node type.
 *
 * @type {Object<String, Object<String, FieldSpec>>}
 */
export const FIELDS = Object.freeze({

	// ---------------------------------------------------------------- Project
	// The document/machine tier. These are properties of THIS piece of work and
	// this machine, so they travel in the project file. Display units and G-code
	// decimal places deliberately do not live here: they change how numbers are
	// shown, not what gets cut, and carrying a presentation choice between
	// projects is harmless where carrying a material thickness is not.
	[NodeType.PROJECT]: Object.freeze({

		...COMMON,

		// The defaults describe a WolfPawn 4040-PRO: 400 x 400 x 75mm, 500W
		// spindle, GRBL 1.1F. They are only defaults -- every one of them is a
		// project setting -- but a default that matches the machine in the room
		// is one less thing to get wrong on the first job.
		workspaceWidth: {
			label: 'Workspace width', desc: 'The machine bed, X.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 400, min: 1, max: 10_000, step: 1,
		},

		workspaceHeight: {
			label: 'Workspace height', desc: 'The machine bed, Y.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 400, min: 1, max: 10_000, step: 1,
		},

		zTravel: {
			label: 'Z travel',
			desc: 'How far the spindle can move up and down in total. The tool has to'
				+ ' reach from safe Z all the way to the bottom of the cut, so this is'
				+ ' a hard limit on safe Z plus cut depth. GRBL knows it as $132.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 75, min: 1, max: 1000, step: 1,
		},

		workZero: {
			label: 'Work zero', desc: 'Where the machine’s 0,0 sits on the workspace. The puck.',
			kind: Kind.VECTOR2, quantity: Quantity.LENGTH, default: { x: 0, y: 0 },
		},

		safeZ: {
			label: 'Safe Z', desc: 'Height for rapid moves, above anything clamped to the bed.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 5, min: 0.1, max: 200, step: 0.5,
		},

		materialThickness: {
			label: 'Material thickness', desc: 'How thick the stock is.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 4, min: 0.01, max: 500, step: 0.1,
		},

		cutThroughAllowance: {
			label: 'Cut-through allowance',
			desc: 'How far past the bottom of the stock a through cut should go, into the'
				+ ' spoilboard. Enough to be sure it is through, not enough to matter.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 1, min: 0, max: 20, step: 0.1,
		},

		rapidRate: {
			label: 'Rapid rate',
			desc: 'How fast the machine moves when it is not cutting. A lead-screw'
				+ ' machine is far slower than a belt one; the true figure is $110 and'
				+ ' $111 in GRBL\'s $$ output.',
			kind: Kind.NUMBER, quantity: Quantity.FEED, default: 1500, min: 1, max: 30_000, step: 100,
		},

		toolChange: {
			label: 'Tool change',
			desc: 'Manual pauses the program between tool groups so you can swap the bit.',
			kind: Kind.SELECT, quantity: Quantity.NONE,
			default: ToolChange.MANUAL, options: Object.values(ToolChange),
		},

		spindleDwell: {
			label: 'Spindle dwell', desc: 'How long to wait after starting the spindle before cutting.',
			kind: Kind.NUMBER, quantity: Quantity.SECONDS, default: 2, min: 0, max: 60, step: 0.5,
		},

		defaultTabLength: {
			label: 'Default tab length', desc: 'The length a newly placed tab starts at.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 6, min: 0.1, max: 200, step: 0.5,
		},

		defaultTabDepth: {
			label: 'Default tab depth',
			desc: 'How deep a newly placed tab is cut, measured from the surface. Zero'
				+ ' leaves the material completely intact there.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 0, min: 0, max: 500, step: 0.1,
		},
	}),

	// ----------------------------------------------------------------- Folder
	[NodeType.FOLDER]: Object.freeze({

		...COMMON,

		role: {
			label: 'Role', desc: 'Which of the three fixed folders this is.',
			kind: Kind.SELECT, quantity: Quantity.NONE,
			default: FolderRole.JOBS, options: Object.values(FolderRole),
		},
	}),

	// ------------------------------------------------------------------- Tool
	// The tool tier. A job inherits these live rather than copying them, so
	// correcting a feed rate on the tool corrects every job that never disagreed.
	[NodeType.TOOL]: Object.freeze({

		...COMMON,

		diameter: {
			label: 'Diameter', desc: 'The cutting diameter. This is the width of the kerf.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 3.175, min: 0.01, max: 50, step: 0.1,
		},

		angle: {
			label: 'Included angle',
			desc: 'For a V-bit. Zero means a flat end mill, which is the only kind v1 cuts with.',
			kind: Kind.NUMBER, quantity: Quantity.ANGLE, default: 0, min: 0, max: Math.PI, step: Math.PI / 180,
		},

		flutes: {
			label: 'Flutes', desc: 'How many cutting edges. A property of the cutter, so a job cannot override it.',
			kind: Kind.NUMBER, quantity: Quantity.COUNT, default: 2, min: 1, max: 12, step: 1,
			physical: true,
		},

		passDepth: {
			label: 'Pass depth', desc: 'The most material this tool should remove in one pass.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 1, min: 0.01, max: 100, step: 0.1,
		},

		stepover: {
			label: 'Stepover', desc: 'How far across the tool steps per pass, as a fraction of its diameter.',
			kind: Kind.NUMBER, quantity: Quantity.FRACTION, default: 0.4, min: 0.01, max: 1, step: 0.05,
		},

		plungeRate: {
			label: 'Plunge rate', desc: 'How fast the tool may move straight down.',
			kind: Kind.NUMBER, quantity: Quantity.FEED, default: 300, min: 1, max: 10_000, step: 50,
		},

		cutFeed: {
			label: 'Cut feed', desc: 'How fast the tool moves while cutting.',
			kind: Kind.NUMBER, quantity: Quantity.FEED, default: 1000, min: 1, max: 30_000, step: 100,
		},

		spindleRpm: {
			label: 'Spindle speed',
			desc: 'How fast the spindle turns. A 500W spindle on a machine this size'
				+ ' tops out around ten thousand; the true ceiling is $30 in GRBL\'s $$'
				+ ' output, and asking for more than that just gets clamped.',
			kind: Kind.NUMBER, quantity: Quantity.RPM, default: 10_000, min: 1000, max: 60_000, step: 500,
		},
	}),

	// -------------------------------------------------------------------- Job
	[NodeType.JOB]: Object.freeze({

		...COMMON,

		paths: {
			label: 'Paths',
			desc: 'The artwork this job cuts. A live reference, so editing the path'
				+ ' changes the cut rather than leaving a copy behind.',
			kind: Kind.REFERENCES, quantity: Quantity.NONE, default: [],
		},

		operation: {
			label: 'Operation',
			desc: 'Which side of the line the tool runs. Open paths have no inside or'
				+ ' outside, so they use centre, normal or heading instead.',
			kind: Kind.SELECT, quantity: Quantity.NONE,
			default: JobOperation.CENTER, options: Object.values(JobOperation),
		},

		cutDepth: {
			label: 'Cut depth',
			desc: 'How deep to cut, measured down from the surface of the stock. An'
				+ ' explicit number: nothing recalculates it when the material changes.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 1, min: 0.01, max: 500, step: 0.1,
		},

		margin: {
			label: 'Margin', desc: 'Material to leave uncut. Negative cuts extra.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 0, min: -100, max: 100, step: 0.1,
		},

		width: {
			label: 'Band width',
			desc: 'For inside and outside: how wide a band to clear, rather than a single pass.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 0, min: 0, max: 1000, step: 0.5,
		},

		combine: {
			label: 'Combine',
			desc: 'How the paths in this job are combined before cutting. Three overlapping'
				+ ' circles cut separately re-cut air the earlier ones already cleared.',
			kind: Kind.SELECT, quantity: Quantity.NONE,
			default: Combine.NONE, options: Object.values(Combine),
		},

		direction: {
			label: 'Direction', desc: 'Which way round the cut runs.',
			kind: Kind.SELECT, quantity: Quantity.NONE,
			default: Direction.CONVENTIONAL, options: Object.values(Direction),
		},

		offsetSide: {
			label: 'Offset side',
			desc: 'For the normal and heading modes: which side of the line the cut sits on.',
			kind: Kind.SELECT, quantity: Quantity.NONE,
			default: Side.LEFT, options: Object.values(Side),
		},

		offsetHeading: {
			label: 'Offset heading',
			desc: 'For the heading mode: the fixed direction the whole path is displaced in.',
			kind: Kind.NUMBER, quantity: Quantity.ANGLE, default: 0, min: 0, max: Math.PI * 2, step: Math.PI / 180,
		},

		ramp: {
			label: 'Ramp in', desc: 'Enter the cut along a shallow slope rather than plunging straight down.',
			kind: Kind.BOOLEAN, quantity: Quantity.NONE, default: true,
		},

		rampAngle: {
			label: 'Ramp angle', desc: 'How steeply to ramp in.',
			kind: Kind.NUMBER, quantity: Quantity.ANGLE,
			default: DEFAULT_RAMP_ANGLE, min: Math.PI / 180, max: Math.PI / 4, step: Math.PI / 180,
		},

		leadIn: {
			label: 'Lead-in',
			desc: 'Length of an approach move from outside the cut. Zero for none. Where'
				+ ' it goes is a choice, not something the program can work out — it'
				+ ' cannot know which side is scrap.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 0, min: 0, max: 200, step: 0.5,
		},

		leadOut: {
			label: 'Lead-out', desc: 'Length of a departure move at the end of the cut. Zero for none.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 0, min: 0, max: 200, step: 0.5,
		},

		leadSide: {
			label: 'Lead side', desc: 'Which side the lead-in and lead-out swing out to.',
			kind: Kind.SELECT, quantity: Quantity.NONE,
			default: Side.LEFT, options: Object.values(Side),
		},

		dogbones: {
			label: 'Dogbones', desc: 'Overcut inside corners so a square peg fits the slot.',
			kind: Kind.BOOLEAN, quantity: Quantity.NONE, default: false,
		},

		// ---- inherited from the Tool unless this job says otherwise ----
		// Absent means inherited. Setting one is an override; clearing it restores
		// the LINK, not a copy of the value it happened to have.

		passDepth: {
			label: 'Pass depth', desc: 'The most material to remove in one pass.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 1, min: 0.01, max: 100, step: 0.1,
			inherit: { from: NodeType.TOOL, field: 'passDepth' },
		},

		stepover: {
			label: 'Stepover', desc: 'How far across the tool steps per pass, as a fraction of its diameter.',
			kind: Kind.NUMBER, quantity: Quantity.FRACTION, default: 0.4, min: 0.01, max: 1, step: 0.05,
			inherit: { from: NodeType.TOOL, field: 'stepover' },
		},

		plungeRate: {
			label: 'Plunge rate', desc: 'How fast the tool may move straight down.',
			kind: Kind.NUMBER, quantity: Quantity.FEED, default: 300, min: 1, max: 10_000, step: 50,
			inherit: { from: NodeType.TOOL, field: 'plungeRate' },
		},

		cutFeed: {
			label: 'Cut feed', desc: 'How fast the tool moves while cutting.',
			kind: Kind.NUMBER, quantity: Quantity.FEED, default: 1000, min: 1, max: 30_000, step: 100,
			inherit: { from: NodeType.TOOL, field: 'cutFeed' },
		},

		spindleRpm: {
			label: 'Spindle speed', desc: 'How fast the spindle turns.',
			kind: Kind.NUMBER, quantity: Quantity.RPM, default: 18_000, min: 1000, max: 60_000, step: 500,
			inherit: { from: NodeType.TOOL, field: 'spindleRpm' },
		},
	}),

	// -------------------------------------------------------------------- Tab
	// A break in the cut, placed by hand. Length and depth fall back to the
	// project's defaults so a run of tabs can be retuned in one place.
	[NodeType.TAB]: Object.freeze({

		...COMMON,

		position: {
			label: 'Position', desc: 'How far along the path the tab sits.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 0, min: 0, max: 100_000, step: 0.5,
		},

		length: {
			label: 'Length', desc: 'How much of the path the tab covers.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 6, min: 0.1, max: 200, step: 0.5,
			inherit: { from: NodeType.PROJECT, field: 'defaultTabLength' },
		},

		depth: {
			label: 'Depth',
			desc: 'How deep the cut goes across the tab, from the surface. Zero leaves the'
				+ ' material completely intact.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 0, min: 0, max: 500, step: 0.1,
			inherit: { from: NodeType.PROJECT, field: 'defaultTabDepth' },
		},
	}),

	// ---------------------------------------------------------------- SvgDoc
	[NodeType.SVG_DOC]: Object.freeze({

		...COMMON,

		source: {
			label: 'File', desc: 'The file this was imported from. The original is kept verbatim.',
			kind: Kind.TEXT, quantity: Quantity.NONE, default: '',
		},

		// A drawing that states no physical size -- a viewBox and nothing else --
		// has no scale of its own, so one has to be assumed. This is where that
		// assumption lives, and changing it re-reads the kept original at the new
		// resolution. It used to be a dialog on every import, which is the wrong
		// shape for a decision you want to make AFTER seeing the result and change
		// again afterwards.
		pixelsPerInch: {
			label: 'Resolution',
			desc: 'How many units to a physical inch, for a drawing that does not say.'
				+ ' 96 is the CSS standard and Inkscape 0.92 and later; 72 is points'
				+ ' and what Illustrator usually writes; 90 is older Inkscape.'
				+ ' Ignored when the file states a real size in mm or inches.',
			kind: Kind.NUMBER, quantity: Quantity.NONE, default: 96, min: 1, max: 2400, step: 1,
		},

		dpiDependent: {
			label: 'Needs a resolution',
			desc: 'True when the drawing states no physical size, so the resolution'
				+ ' above is what decides how big it is.',
			kind: Kind.BOOLEAN, quantity: Quantity.NONE, default: false,
		},

		widthMm: {
			label: 'Drawing width',
			desc: 'How wide the imported artwork came out. Measure the real thing'
				+ ' against this — if it disagrees, the resolution is wrong.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 0, min: 0, max: 100_000,
		},

		heightMm: {
			label: 'Drawing height',
			desc: 'How tall the imported artwork came out.',
			kind: Kind.NUMBER, quantity: Quantity.LENGTH, default: 0, min: 0, max: 100_000,
		},

		notes: {
			label: 'Import notes',
			desc: 'Anything the importer had to say about this file.',
			kind: Kind.TEXT, quantity: Quantity.NONE, default: '',
		},

		// ---- where it sits ----
		// A transform on the NODE, not rewritten path data. Changing an SvgDoc's
		// resolution re-reads the kept original and keeps these ids, so geometry
		// that had been dragged would lose every placement with no error and no
		// undo entry to point at. See placement.js.

		offset: {
			label: 'Position', desc: 'How far it has been moved from where the file put it.',
			kind: Kind.VECTOR2, quantity: Quantity.LENGTH, default: { x: 0, y: 0 },
		},

		rotation: {
			label: 'Rotation', desc: 'How far round it is turned, about its own centre.',
			kind: Kind.NUMBER, quantity: Quantity.ANGLE,
			default: 0, min: -Math.PI * 2, max: Math.PI * 2, step: Math.PI / 180,
		},

		scale: {
			label: 'Scale', desc: 'How much bigger or smaller than the file drew it. 1 is as drawn.',
			kind: Kind.VECTOR2, quantity: Quantity.NONE, default: { x: 1, y: 1 },
		},
	}),

	// --------------------------------------------------------------- SvgPath
	[NodeType.SVG_PATH]: Object.freeze({

		...COMMON,

		geometry: {
			label: 'Geometry', desc: 'Id of the path data, which lives outside the document. Not editable here.',
			kind: Kind.TEXT, quantity: Quantity.NONE, default: '',
		},

		closed: {
			label: 'Closed', desc: 'Whether the path returns to where it started. Decides which operations mean anything.',
			kind: Kind.BOOLEAN, quantity: Quantity.NONE, default: false,
		},

		// ---- where it sits ----
		// A transform on the NODE, not rewritten path data. Changing an SvgDoc's
		// resolution re-reads the kept original and keeps these ids, so geometry
		// that had been dragged would lose every placement with no error and no
		// undo entry to point at. See placement.js.

		offset: {
			label: 'Position', desc: 'How far it has been moved from where the file put it.',
			kind: Kind.VECTOR2, quantity: Quantity.LENGTH, default: { x: 0, y: 0 },
		},

		rotation: {
			label: 'Rotation', desc: 'How far round it is turned, about its own centre.',
			kind: Kind.NUMBER, quantity: Quantity.ANGLE,
			default: 0, min: -Math.PI * 2, max: Math.PI * 2, step: Math.PI / 180,
		},

		scale: {
			label: 'Scale', desc: 'How much bigger or smaller than the file drew it. 1 is as drawn.',
			kind: Kind.VECTOR2, quantity: Quantity.NONE, default: { x: 1, y: 1 },
		},
	}),

	// -------------------------------------------------------- ReferenceImage
	[NodeType.REFERENCE_IMAGE]: Object.freeze({

		...COMMON,

		asset: {
			label: 'Image', desc: 'Id of the image, which lives outside the document.',
			kind: Kind.TEXT, quantity: Quantity.NONE, default: '',
		},

		opacity: {
			label: 'Opacity', desc: 'How strongly to draw it under the artwork.',
			kind: Kind.NUMBER, quantity: Quantity.FRACTION, default: 0.5, min: 0, max: 1, step: 0.05,
		},

		rotation: {
			label: 'Rotation', desc: 'How far round it is turned.',
			kind: Kind.NUMBER, quantity: Quantity.ANGLE, default: 0, min: 0, max: Math.PI * 2, step: Math.PI / 180,
		},

		scale: {
			label: 'Scale', desc: 'Millimetres per pixel. Set by Calibrate Scale rather than by hand.',
			kind: Kind.NUMBER, quantity: Quantity.NONE, default: 1, min: 1e-6, max: 1000, step: 0.001,
		},

		scaleLocked: {
			label: 'Scale locked',
			desc: 'Once calibrated, stops the scale being changed by dragging. Rotation and'
				+ ' position stay free.',
			kind: Kind.BOOLEAN, quantity: Quantity.NONE, default: false,
		},
	}),

	// ---------------------------------------------------------- WorkMaterial
	[NodeType.WORK_MATERIAL]: Object.freeze({

		...COMMON,

		paths: {
			label: 'Outline',
			desc: 'The path describing the shape of the stock. A reference, not a copy,'
				+ ' so redrawing the outline moves the stock with it.',
			kind: Kind.REFERENCES, quantity: Quantity.NONE, default: [],
		},
	}),
});


/**
 * Which node types may be a child of which.
 *
 * The hierarchy is fixed, not arbitrary: `Project > Jobs\ > Tool > Job > Tab`,
 * and separately `SVGs\ > SvgDoc > SvgPath` and `References\ > ReferenceImage`.
 * Tool groups exist because tree order is emission order and a tool boundary is
 * a tool change (D7), so a job cannot sit outside one.
 *
 * @type {Object<String, String[]>}
 */
export const ALLOWED_CHILDREN = Object.freeze({
	[NodeType.PROJECT]: [NodeType.FOLDER, NodeType.WORK_MATERIAL],
	[NodeType.FOLDER]: [NodeType.TOOL, NodeType.SVG_DOC, NodeType.REFERENCE_IMAGE],
	[NodeType.TOOL]: [NodeType.JOB],
	[NodeType.JOB]: [NodeType.TAB],
	[NodeType.TAB]: [],
	[NodeType.SVG_DOC]: [NodeType.SVG_PATH],
	[NodeType.SVG_PATH]: [],
	[NodeType.REFERENCE_IMAGE]: [],
	[NodeType.WORK_MATERIAL]: [],
});

/**
 * The folders whose order means something.
 *
 * Order in `Jobs\` is the order the machine cuts in. Everywhere else it is
 * however the user likes it arranged.
 *
 * @type {String[]}
 */
export const ORDERED_ROLES = Object.freeze([FolderRole.JOBS]);


/**
 * The fields defined for a node type.
 *
 * @param {String} type - one of {@link NodeType}
 * @returns {Object<String, FieldSpec>} the specs, by field name
 * @throws {TypeError} when the type is not one of ours
 */
export function fieldsOf(type) {

	const fields = FIELDS[type];

	if (fields === undefined)
		throw new TypeError(`Unknown node type "${type}"`);

	return fields;
}


/**
 * One field's spec.
 *
 * @param {String} type - one of {@link NodeType}
 * @param {String} field - the field name
 * @returns {FieldSpec|null} the spec, or null when that type has no such field
 */
export function fieldSpec(type, field) {
	return fieldsOf(type)[field] ?? null;
}


/**
 * Makes a new node, with every non-inherited field at its default.
 *
 * Inheritable fields are left ABSENT rather than filled in. That is the whole
 * difference between live-linked inheritance and copy-at-creation: a job created
 * today and a job created after the tool's feed was corrected must both follow
 * the tool, and they only do if neither wrote the value down.
 *
 * @param {String} type - one of {@link NodeType}
 * @param {Object} [props] - values to set, overriding defaults. Unknown names throw
 * @param {Object} [options] - options
 * @param {Function} [options.newId] - id factory, injectable so tests are deterministic
 * @returns {Object} the node
 * @throws {TypeError} for an unknown type, or a prop the type does not define
 */
export function createNode(type, props = {}, options = {}) {

	const { newId = defaultNewId } = options;
	const fields = fieldsOf(type);

	/** @type {Object} */
	const node = { id: props.id ?? newId(), type };

	for (const [field, spec] of Object.entries(fields))
		if (spec.inherit === undefined)
			node[field] = clone(spec.default);

	for (const [field, value] of Object.entries(props)) {

		if (field === 'id')
			continue;

		if (fields[field] === undefined)
			throw new TypeError(`${type} has no field "${field}"`);

		node[field] = clone(value);
	}

	if (node.name === '')
		node.name = type;

	if (ALLOWED_CHILDREN[type].length > 0)
		node.children = [];

	return node;
}

/**
 * Copies a default so two nodes never share one object.
 *
 * Only ever sees the plain data a FieldSpec default can be — a number, a string,
 * a boolean, or a small object like `workZero`.
 *
 * @param {*} value - the value
 * @returns {*} a copy
 */
function clone(value) {

	if (value === null || typeof value !== 'object')
		return value;

	return Array.isArray(value) ? value.map(clone) : Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

/**
 * The default id factory.
 *
 * @returns {String} a uuid
 */
function defaultNewId() {
	return globalThis.crypto.randomUUID();
}
