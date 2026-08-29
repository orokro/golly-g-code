# GollyGCode — Build Plan

A local-first SVG → G-code CAM application for hobby CNC routers.
Vue 3 + Electron + `vue-win-mgr`, with a framework-free CAM core.

> **How to use this file.** Every item is a checkbox. Tick them as they land.
> Items marked **[RISK]** have real unknowns and should be prototyped before
> anything depends on them. Items marked **[SPIKE]** are throwaway experiments —
> the deliverable is an answer, not code we keep.
>
> The **MVP line** sits at the end of Phase 5. Everything above it is required to
> cut real material. Everything below it is polish and visualization.

---

## 0. Locked decisions

These were settled during planning. Recorded here so we don't relitigate them
mid-build. If one of these turns out wrong, change it *here* first.

| # | Decision | Reasoning |
|---|---|---|
| D1 | **Modern hardware only for v1.** No old-Mac constraint. | G-code is generated on the Windows PC and copied to the 2017 MacBook running CNCJS. An old-Mac branch may be attempted last, if at all. (If ever: Electron 43 / Chromium M150 is the final line that runs on macOS 12 Monterey — Chrome 151 dropped it in July 2026.) |
| D2 | **Toolpaths are the source of truth. G-code is derived.** | Nothing in the app parses G-code in the normal path. The parser exists only as a test oracle and for the stretch-goal round-trip. |
| D3 | **Jobs are fully detached from SVGs.** | SVGs are an import conduit, not a parent. There is no SVG editing in the app, so a link has nothing useful to propagate. The intended workflow is many jobs from one path, each placed independently. Deleting an SVG does nothing to its jobs. A non-functional `from: file.svg › path_04` provenance label is kept for debugging and auto-naming only. |
| D4 | **Import-time scale correctness** replaces the linking safety net. | Honour `viewBox` / `width` / `height` / real unit suffixes, and show detected physical size at import with a chance to correct — *before* any job exists. Plus a "scale selected jobs by factor" batch op as the escape hatch. |
| D5 | **Workspace renders as SVG/DOM.** | Browser gets us culling, dirty-rect, event dispatch and — decisively — `document.elementsFromPoint()`, which is Blender-style click-cycling for free. |
| D6 | **Preview2D is Canvas2D. Preview3D is three.js.** | Multiple WebGL contexts are acceptable (one renderer per mounted window, sharing one `Scene`). Realistically 2–3 3D views max. |
| D7 | **Settings tier: Document → Tool → Job.** | Outliner nests `Jobs\ > Tool\ > Job`. Tree order *is* emission order; tool boundaries *are* tool-change breaks. |
| D8 | **Undo/redo via command pattern, from day one.** | The store is writable only by the dispatcher. Gizmo drags emit one coalesced command on mouse-up, which doubles as the G-code regen trigger. |
| D9 | **Language: JavaScript + JSDoc**, tabs for indentation, file-header docblocks. | Matches house style. Drives D10. |
| D10 | **Valibot** for schema validation. | Zod's edge is TS inference, which JSDoc-JS doesn't benefit from. Valibot is ~1.5 KB tree-shaken. |
| D11 | **Project file is a zip container** (`.gollyg`): `project.json` + `assets/` + original SVGs verbatim. | Reference photographs would bloat a single JSON. |
| D12 | **Post-processor is a swappable module.** | Dialect selected by project tooling type (spindle now, laser later). |
| D13 | **Inspector is scratch-built.** `vue-settings-panel` is only for app-level settings. | The panel supports one nesting level and its `validate()` is cosmetic. The Inspector needs gizmo linkage and real validation. |
| D14 | **`cam-core` lives in the renderer**, optionally inside a Web Worker. | Worker `postMessage` needs no preload bridge. "Headless" only means it must not import Vue or touch the DOM, so vitest can run it. |
| D15 | **No V-carve in v1.** | No V-bit owned. Needs a medial-axis/Voronoi computation. The Job model must allow adding an operation kind without surgery. |
| D17 | **The kerf is the artwork; we are not freeing a part.** Greg: *"My main goal is to make the bit follow the path I drew, and the width of the cut will show me what detail I'll actually get IRL... I realize there's more detail that would be able to be cut by a 1/8th bit - but I don't really care."* | Reframes several things. Detail finer than the bit is a normal consequence to SEE, not a warning to emit. "Is the part held" is the wrong question — nothing is being cut free. Tabs are hand-placed on straight sections by eye, so no automatic placement and no reasoning about tabs in crevices. What the program owes the user is an honest picture of the cut's width. |
| D16 | **No spoilboard guardrail.** Model an explicit **cut-through allowance** instead. | Current workflow deliberately cuts into a pre-routed spoilboard groove (vinyl records, O-flute, single pass). Warn only past `thickness + allowance`. |

### Repo layout

```
GollyGCode/                     <- reference workspace (not a repo)
├─ jscut/                       <- reference only
├─ NCviewer/                    <- reference only
├─ Vue-Window-Manager/          <- PATCHED locally, consumed via file: dep
├─ vue-settings-panel/
├─ electron-vue-template/       <- scaffold source
└─ gollygcode/                  <- THE PROJECT
   ├─ plan.md                   <- this file
   ├─ src/
   │  ├─ core/                  <- cam-core: zero Vue, zero DOM, vitest-covered
   │  ├─ main/                  <- Electron main + preload
   │  └─ renderer/              <- Vue app
   └─ tests/
```

Single package, not a monorepo — a solo project doesn't need workspace overhead.
`src/core/` stays extractable: an ESLint `no-restricted-imports` fence forbids
`vue` / DOM globals inside it, and it exposes one barrel `index.js`. If it ever
deserves its own npm package, the move is a `git mv`.

---

## Phase 0 — Foundations & spikes

Goal: a running Electron window with a patched window manager, a test runner,
and none of the template's landmines left armed.

### 0.1 Repo
- [x] `git init` in `gollygcode/`, `.gitignore` (node_modules, dist, build, *.gollyg test output)
- [x] Copy scaffold from `electron-vue-template`, strip the demo (`HelloWorld.vue`, demo IPC)
- [x] Rename: `appId`, `productName`, `name` → GollyGCode
- [x] Convert to JavaScript + JSDoc; delete the TS-specific tsconfigs, keep `jsconfig.json` for editor intellisense
- [x] `.editorconfig` — tabs, LF
- [x] ESLint + `@stylistic` — tabs enforced, JSDoc required on exported functions and file headers

### 0.2 Defuse the template's known landmines
Each of these fails **only in the packaged build**, never in `npm run dev`.
- [x] **CSP.** `main.ts` sets `script-src 'self'`, which blocks blob workers (Monaco instantiates its language services that way) and wasm outright. Widen to `script-src 'self' blob: 'wasm-unsafe-eval'; worker-src 'self' blob:`
- [x] **`file://` origin.** Template uses `loadFile()`. Module workers and `fetch()`-based wasm loading both fail from an opaque origin. Register an `app://` scheme via `protocol.handle()` and `loadURL('app://...')` — one change that unblocks workers, wasm and Monaco together
- [x] **`scripts/build.js` uses `Promise.allSettled`** — a main-process compile error prints success and packages partial output. Change to `Promise.all`
- [x] `electron-builder.json` has **no `mac` key at all** — add targets/arch even though macOS isn't a v1 target, so a stray `build:mac` doesn't silently produce something broken
- [x] Upgrade Electron / Vite / Vue to current (D1 removes the version ceiling)

### 0.3 Patch `vue-win-mgr` locally
Consumed as `"vue-win-mgr": "file:../Vue-Window-Manager"` (npm symlinks it; `npm run build` in that repo first). Publish to npm later once the API settles.
- [x] **`@layout-changed` emit on `WindowManager`.** Confirmed absent — the only emits in the entire library are `update:showTopBar`, `update:showStatusBar`, `update:splitMergeHandles`. Fire debounced (~250ms) after any structural change: window added/removed/moved, frame split/merged, tab switched, splitter released. Payload = `getLayoutDetails()`
- [x] **`windowCtx.isVisible`** — a computed ref, plus `windowCtx.onVisibilityChange(cb)`. Derived from the agreed heuristic:
  - MWI frame → visible unless `window.minimized`
  - Tabbed frame → visible iff `frame.getActiveWindow() === thisWindow`
  - Single frame → always visible
- [x] **Expose `frameCtx.getActiveWindow()`** on `WindowFrameContext` (it exists on `WindowFrame` but isn't public)
- [ ] *(optional, cheap while we're in there)* `windowCtx.onResize(cb)` backed by one internal `ResizeObserver`, so every canvas window doesn't need its own
- [x] Rebuild, verify `dist/style.css` filename and whether it needs an explicit import in the app

### 0.4 Test + tooling
- [x] Vitest, running `src/core/**/*.test.js` headlessly
- [x] ESLint fence: `no-restricted-imports` for `vue` inside `src/core/`
- [x] A `dev:lab` Vite entry serving standalone visual test pages (geometry prototypes render to inline SVG — far more useful than assertions for offset debugging)

### 0.5 Units & coordinate convention **[decide once, obey forever]**
- [x] Internal storage is **float64 millimetres, Y-up**, everywhere
- [x] Conversion happens at exactly three boundaries: SVG import, Clipper integer scaling, G-code emission
- [x] Display unit is a single project-wide setting (jscut's six independent unit dropdowns are the anti-pattern)
- [x] `Unit` helpers + tests: mm↔inch, formatting, parsing user input with unit suffixes

### 0.6 Spikes
- [x] **[SPIKE]** Evaluate Clipper bindings: `clipper2-js` (pure JS port) vs `clipper2-wasm` vs `js-angusj-clipper` (wasm, Clipper1). Criteria: open-path inflate support, bundle size, whether wasm loading survives the `app://` change from 0.2. **Answer needed before 1.3.**
- [x] **[SPIKE]** Integer scale factor for Clipper. jscut used inch×100000. In mm-native terms, decide a scale that keeps sub-micron precision without overflowing on a 1200mm workspace.

**Spike answers (resolved):**

- **Library: `clipper2-ts`, pinned to exactly `2.0.1`.** Not `^` -- the `latest`
  dist-tag points at a prerelease (`2.0.1-18`).
- **`clipper2-js` is disqualified: it returns mathematically wrong geometry.**
  Inward-offsetting a plain square produces garbage for every join type, and a
  shape smaller than the offset fails to vanish. It also has no `arcTolerance`
  parameter and declares an `@angular/core` peer dependency.
- **Both wasm options need full `'unsafe-eval'`**, not `'wasm-unsafe-eval'`.
  Emscripten's glue calls `new Function` at module init. Verified with
  `node --disallow-code-generation-from-strings`. Choosing pure JS is what lets
  our CSP stay tight -- and a Worker inherits the document's CSP, so moving the
  work off-thread would not have escaped it.
- **It is faster than what jscut shipped anyway**: 2.35 ms/op vs clipper-lib's
  3.10 ms/op on a 240-point star; 4.5 s vs 6.9 s for a 124-pass pocket.
- **`SCALE = 10_000`** (1 unit = 1e-4 mm = 100 nm). Safe coordinate range is
  +/-47,453,132 (the float64 fast path); a 1200 mm workspace reaches 12,000,000,
  leaving ~4x linear headroom. Never leaves the fast path.
- **Open-path offsetting works**, with all four end types (Butt / Square / Round /
  Joined). A 3-point open polyline inflates to exactly one closed stadium outline.
  `Round` gives true semicircular caps -- the real swept area of a round endmill.

**Rules this forces on Phase 1 (do not skip):**

- [x] **Pocket passes must be computed from the ORIGINAL boundary, not chained.**
  Measured drift over 100 passes: 2710 nm chained vs 10 nm from-original.
- [x] **Normalise imported SVG with a union before offsetting.** Self-intersecting
  input offsets into spurious slivers (measured: 3 paths instead of 1).
- [x] **Guard degenerate input.** clipper2-ts does not validate; empty paths and a
  1-point path with `EndType.Polygon` throw raw `TypeError`s.
- [x] **Round arcs are inscribed, never circumscribed** -- an outward offset comes
  out marginally undersized. Offset by `radius + tolerance` where clearance matters.
- [x] **No coordinate-range exception is thrown.** Above 2^53 you get silent
  precision loss, not an error. Validate input extents ourselves.

---

## Phase 1 — `cam-core` (headless, tested, no UI)

Goal: `SVG string + settings → toolpaths → G-code text`, provably correct,
runnable in Node, with zero knowledge that Vue exists.

This phase is front-loaded deliberately: the CAM correctness is the risky part,
the UI is the part we've built before. A bug here ruins material.

### 1.1 SVG import — fix jscut's biggest gap
jscut supports **only `<path>` and `<rect>`**; everything else throws
*"…is not supported; try Inkscape's Object to Path"*. That's the polyline
complaint. It also ignores `viewBox` entirely.
- [x] Parse the full primitive set: `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`
- [x] Resolve `<use>` references and nested `<svg>`
- [x] Accumulate ancestor `transform` matrices correctly (incl. `transform-origin`)
- [x] Honour `viewBox` + `width`/`height` + unit suffixes (`mm`, `cm`, `in`, `pt`, `pc`, `px`) → real physical size
- [x] **A px/inch override for unitless documents.** Half of jscut's px-per-inch box is a
  real failing (it ignores stated units) and half is unavoidable: `width="612"` with no
  unit is equally valid as 612 CSS px @96 (161.9mm) or 612 points @72 (215.9mm = US
  Letter), and Illustrator writes exactly that. `dpiDependent` on the result says which
  case a document is in, so the import UI can offer the control **only when it would
  change something** rather than always asking.
- [x] **`preserveAspectRatio` handled** (meet/slice + alignment) — when the stated size and
  the viewBox disagree on aspect, the content is uniformly scaled and aligned, not stretched
- [ ] Text → outlines (opentype.js or the browser's own text-to-path; needs a decision — Node-side tests push toward opentype.js)
- [x] Preserve `fill-rule` per element (jscut discards it after the first simplify)
- [x] Report unsupported/skipped content explicitly instead of failing silently
- [x] **Minimal CSS stylesheet support** — Illustrator's default preset puts properties in an
  internal `<style>` with `class="st0"` on shapes. Simple selectors only (tag/.class/#id);
  anything else is warned about, not half-applied. `display:none` in a class is a correctness
  issue, not a cosmetic one — ignoring it imports shapes the artwork does not draw.
- [x] **Foreign namespaces ignored by namespace, not by tag name** — Inkscape's `sodipodi:`,
  RDF metadata and Adobe private tags need no per-editor allow-list.
- [x] Tests: a fixture SVG per primitive, per unit suffix, per transform nesting depth

### 1.2 Path normalization
- [x] Everything → absolute cubic béziers *(**revised**: arcs are NOT converted — see below)*
- [x] **Arcs preserved as a first-class segment type.** Converting them to cubics bakes in
  ~0.00027 x radius of radial error that the flattener cannot see or recover; a 50mm circle
  came out 0.0111mm off a 0.01mm tolerance. Arcs now flatten analytically (the sagitta of a
  circular segment has a closed form), and as a bonus an arc that survives to the post-processor
  can be emitted as a real G2/G3 move — partially pre-paying §1.9.
- [x] **Deviation-based flattening** (max sagitta ≈ 0.01mm), *not* jscut's chord-length rule — that rule gives a gentle 200mm arc and a 2mm arc wildly different accuracy
- [ ] Douglas–Peucker post-filter at a tolerance below machine resolution, plus a minimum segment length — kills near-collinear runs that make GRBL's planner decelerate
- [x] Open vs closed detection (explicit `Z`, or first≈last within epsilon). jscut assumes everything is closed; this is where open-path support begins
- [x] Tests: flattening error bounds asserted numerically; point counts sane

### 1.3 Geometry layer
- [x] Clipper wrapper: `offset`, `union`, `intersect`, `difference`, `xor`, `simplify`
- [x] Integer scale + round-trip precision tests (offset by +d then −d returns within tolerance)
- [x] Arc tolerance as a real deviation parameter, not a magic constant

### 1.4 Closed-path operations
- [x] **Outside** — offset outward by tool radius (+ margin)
- [x] **Inside** — offset inward
- [x] **Center** — cut on the line
- [x] **Engrave** — on the line, no offset, `margin` ignored
- [x] **Engrave must use the decomposed contour, not the path as drawn.** A compound
  shape is commonly authored as ONE closed path with a zero-width bridge running out
  to its hole and back (confirmed in jscut's own test.svg: `path3034` retraces
  x=32.8 from y=70.3 to y=79.6). Area operations resolve the bridge automatically via
  the union, but engraving the raw path would run the tool along the bridge and slit
  the part. Detect self-touching contours (a single closed subpath that normalizes to
  more than one path) and warn, since the user may not know the bridge is there.
  **Scope note:** there are two ways to author a hole and only one has this problem.
  The modern form — several subpaths in one `d` (`M…Z M…Z`) with a fill rule, which is
  what Illustrator's Create Outlines emits — is already safe: each subpath is its own
  closed loop with no connector. Only the single-subpath bridged form needs decomposing.
  jscut's test.svg has 16 single-subpath and 3 multi-subpath paths, so both occur in the
  wild, but this is a correctness guard for imported third-party files rather than a
  workflow to design around. Authoring the two contours as separate paths — and so as
  separate jobs — sidesteps it entirely, and is better practice anyway.
- [x] **Pocket** — concentric inward rings at stepover until empty
- [x] Climb vs conventional (winding reversal; note the direction convention must flip between inside and outside so "climb" means the same physical thing on both)
- [x] Depth stepping: `topZ → botZ` in pass-depth increments, final pass clamped
- [x] Tests: each op against hand-computed expected geometry on simple shapes

### 1.5 Open-path operations **[RISK — prototype before the UI exists]**
This is the single highest-unknown item in the plan. jscut has nothing here —
it force-closes open paths, which is the bug that motivated the project.
An open path has no enclosed area, so inside / outside / centre — all defined
relative to one — do not apply. Three operations stand in for them, reachable
through one entry point, `openToolpath`, because choosing between them is what a
person does while dialling a job in. Greg: *"This will allow me to, in the final
app, experiment with bit sizes, offset amounts, and etc to dial in a tool path
that is a reasonable shape even if the source SVG is higher frequency detail than
would be possible to reproduce."*
- [x] **Centre.** Tool centre on the line; the cut straddles it, half a diameter
  each side. The only mode that follows the drawing verbatim.
- [x] **System A: heading offset.** Displace the whole path along one fixed angle. Trivial geometry; the work is the UI knob (Phase 4)
- [x] **System B: path-normal offset.** Follows the shape, and puts the drawn
  line on one EDGE of the cut rather than up its middle
- [x] **Side A / side B** selector
- [x] `openToolpath(points, { mode, distance, side, angleRadians })` — one call,
  one field to change between them. Note `distance` is the tool RADIUS for a cut
  whose edge lands on the line, not its diameter.
- [x] ~~**"Clean" slider.**~~ **Removed — there is nothing to tune.** The first
  implementation built the offset by hand (arcs outward, mitres inward) and then
  discarded folded points, on the observation that a folded point ends up closer to
  the source than the offset distance. That passed a property test on every vertex
  and was still wrong: the filter examined POINTS, the tool follows SEGMENTS. On a
  coarse zigzag a mitre overshot past a peak, both endpoints a legitimate distance
  away while the segment between them cut through the source — measured closest
  approach 0.0000mm against a requested 1.5875mm.
- [x] **Normal offset delegates to Clipper's open-path inflate** (the documented
  fallback), which is a true Minkowski offset and cannot produce that. Measured on the
  same path it holds 1.5824mm, the 0.005mm shortfall being exactly the arc tolerance
  since polygonal arcs are inscribed. What remains in our code is extracting one side
  of the closed outline, which Clipper does not do.
- [x] **Tests sample ALONG segments, not just at vertices** — the distinction that
  separated a passing test from working geometry.
- [x] **One side is ONE path, and the split is topological, not geometric.** The
  outline is a closed loop: end, one side, end, the other side. So "the left
  side" is the stretch of loop between the two ends of the path. Walk it and you
  are done — one continuous cut, start to finish, which is what a person drawing
  a line expects.
- [x] ~~Per-point side classification~~ **Removed. It was the wrong question.**
  Asking each outline point "which side of the nearest source segment are you
  on?" has no good answer in two ordinary places: at a reversal the two sides
  SWAP in space (the tool should wrap the tip and carry on), and where the offset
  merges over a valley narrower than twice the tool the outline belongs to
  neither side. It cut the path into pieces exactly where it should have kept
  going — NINE on Greg's 25-point skyline, three of them sub-millimetre slivers
  sitting across the line. Greg, on seeing the picture: *"the skyline is one
  continuous line. Why can't it start on the left side, go to the right in one
  cut?"* It can. It always could. Deleted with it: allRuns, the per-edge
  clearance test, the corner tie-break, the spatial index, and the fragments.
  Both sides of the 214-point skyline now take 28ms rather than 35.
- [x] **ROUND ends, so safety is structural.** Butt ends put a straight edge
  ACROSS the path, running from full offset on one side, through the line, to
  full offset on the other — every point of it nearer than the offset distance.
  The guarantee then depends on the walk excluding those edges, and where the
  offset merges near an end the cap stops being one identifiable edge and the
  exclusion quietly fails: 4.4087mm measured against a required 5.994mm. With
  round ends every point of the outline is exactly the offset from the source, so
  ANY arc of it is safe. A split mistake now costs coverage, never the work.
- [x] **Says so when the offset swallows an end.** At an offset large enough that
  the path's end is no longer on the boundary, the cut cannot start where it was
  asked to. It still cannot cut too close, but it returns a warning rather than
  quietly beginning somewhere else.
- [ ] Both systems composable (heading + normal at once)
- [x] **Visual test page** in `dev:lab` with pathological inputs: tight S-curves, cusps, near-180° reversals, a spiral, a zigzag with corners tighter than the tool
- [ ] ~~Fallback if the distance-filter approach fails~~ — taken; this IS the
  implementation now.

### 1.6 Toolpath linking & ordering
**Mostly dissolved.** It existed because the offset was fragmenting paths that
should never have been fragmented; fixing 1.5 removed the problem rather than
solving it. One side of an open path is now one cut with one plunge, so on
Greg's skyline there is nothing left to link or order.

Greg's two rulings stand and shaped what remains: *"the machine moves pretty
quick so I personally don't care about"* travel time, so nothing here is
justified by seconds; and this whole area *"seems like some unnecessary
optimization and is hard to follow"*, which it was.

- [x] ~~`mergePaths` — greedy nearest-neighbour ordering~~ **Rejected, and it is
  actively harmful.** jscut can re-enter a closed loop at any vertex, so
  nearest-start is a fair proxy for nearest-anything. Open paths have two ends
  and a fixed direction, so greedy grabs a path because its START is near and
  strands the tool at the far end. Measured: 434mm of travel against 246mm for
  doing nothing at all.
- [ ] **Inner-before-outer ordering.** The one hard constraint, and the only item
  here that is about correctness: cut a part free before cutting its inside and
  it is a loose piece under a spinning cutter.
- [ ] `crosses(bounds, a, b)` — **still wanted, but for POCKETS, not for this.**
  Concentric pocket rings sit inside already-cleared material, so the connector
  between them stays down and they chain into one continuous path. Notes from the
  open-path investigation, kept because they will apply there: "bounds" must be
  grown slightly, since a cut's endpoints sit exactly on the boundary and a
  strict inside-test rejects its own input; and clearance from the source is NOT
  the test — a 38mm connector holding a full 1.5875mm clearance while crossing
  open air above the roofs must still be refused.
- [ ] `safeToClose` flag → skip retracts between depth passes when the closing chord stays in bounds
- [x] ~~Drop cut fragments not worth a plunge~~ — **moot.** The fragments were
  artefacts of the side classification, not real geometry. There are none now.
- [x] **Lab page `lab/link.mjs`** draws the moves between cuts, which a toolpath
  drawing normally omits. Greg's idea. Built to compare orderings; what it showed
  instead was that there was nothing to order, which is how the 1.5 bug was
  found. Kept as the check that this stays true, and as the prototype for the
  Workspace travel layer.

### 1.7 Tabs (holding tabs)
jscut's are broken: `separateTabs` lives in a gitignored emscripten blob whose
CDN fallback is dead, and the JS fallback path has a return-type bug that emits
`G1 XNaN YNaN`. Done differently, in pure JS — `src/core/cam/tabs.js`.

**A tab is a BREAK in the cut**, not a ride-over at reduced depth. Greg: *"they
should just be breaks in the cut placed wherever I want, i.e. the tool moves
completely up to the safe zone above the work, moves across the tab, plunges
back down, continues. That might not be the most optimal path, but eh its
logical enough."* It is also much easier to reason about at the machine.

**Tab depth is a depth**, measured down from the surface exactly like cut depth;
what is left is whatever lies below it. Greg's worked example, which the tests
are built on: 4mm stock cut 5mm into the spoilboard, 1mm passes, so five passes.
A tab at 3mm leaves 1mm standing, and breaks only passes 4 and 5 — the first
three run straight through it as if it were not there. A tab at 0 is never cut.

- [x] Tab anchored as **normalized arc-length position on the source path**
- [x] **Resolved onto the toolpath at generation time**, and the mapping depends
  on the MODE. `openToolpath` reports `congruent`: true for centre and heading,
  where the toolpath is the drawing moved rigidly and a position maps arc length
  for arc length; false for a normal offset, where the two paths are different
  lengths and nearest-point projection is the only honest correspondence. Using
  projection for both looks fine until the path has a corner — a 6mm heading
  offset put a tab 6mm along from where it was placed, because the nearest piece
  of shifted toolpath was around the corner rather than straight across.
- [x] Verified across cutters of 1, 3.175, 6 and 12mm AND across all four
  modes: the tab sits exactly its offset distance from the point on the drawing
  where it was placed, and stays the width asked for. jscut anchors to the
  toolpath, so changing the cutter moves and resizes every tab.
- [x] **Per-tab length AND depth, each with a job default** — real units, not %
- [x] `planPass(toolpath, spans, passZ)` returns the runs actually cut on one
  pass; the gaps between them are the retract-rapid-plunge. How to leave and
  re-enter the cut is left to the post-processor, since lead-ins (1.8) want a say
- [x] Tabs suppressed on passes above them, where there is nothing to break
- [x] Merged tabs take the SHALLOWER depth, so the most material survives
- [x] Tests: position and width stable across tool-diameter changes; the whole
  worked example above, pass by pass
- [x] **The bridge is a wedge, and the length means the part edge.** At full
  depth the cutter touches the line at one point and never crosses it, so the
  material standing at the part edge is exactly the span — verified against the
  full-depth toolpath, not against the span arithmetic. Further into the kerf
  the disc reaches r ahead and behind, so an L-long tab is L − 2r at the outer
  edge; at L = 2r it is a knife edge, which `placeTabs` warns about.
- [x] ~~Warns when a tab lands where the cutter cannot follow the line~~
  **Removed — the heuristic was wrong.** It flagged a tab when one END projected
  onto the toolpath from further away than the offset, reasoning that the end sat
  in a crevice the cutter could not enter and so the tab was doing nothing. On
  Greg's skyline it called two of four tabs useless. He did not believe it from
  the picture and he was right: measured, those two leave **23.70mm** and
  **22.30mm** standing against the 8mm asked for. Unreachable material makes a
  bridge LARGER, not smaller. An end in a crevice says nothing about the bridge.
- [x] `measureBridges(source, runs, toolRadius)` replaces the guess with the
  measurement: sweep the cutter along the runs actually cut and report the
  stretches of source it never reaches. It reports ALL standing material, not
  just tabs. Kept because it is the honest version of the question, but see
  D17 — it is a diagnostic, not something to warn about.
  Distance is measured to the run SEGMENTS, not to samples along them. Sampling
  looks equivalent and is not — the toolpath runs tangent to the source, so a
  radial error of e becomes a longitudinal error of sqrt(2·r·e) at every bridge
  end, and sampling at a quarter of the tool radius measured a requested 8mm
  bridge as 7.40mm.
- [ ] ~~Cutting each unbroken run to full depth before moving on~~ — would save
  retracts. Greg: *"that's less interesting."* Not doing it.
- [ ] Dragging a tab along the path, and editing its depth and length, in the
  Workspace (Phase 4)

### 1.8 Quality features jscut lacks
`src/core/cam/entry.js`. Both the ramp and the leads exist for one reason: an
end mill cutting straight down is doing the thing it is worst at. Most have poor
or no centre-cutting geometry, so a vertical plunge rubs rather than cuts, heats
the tip, and marks the one spot the tool dwells longest.

- [x] **Ramp plunge.** Travel along the line descending, then come back,
  arriving at the start at full depth. The there-and-back matters: a
  forward-only ramp reaches depth some way along, leaving the first stretch
  shallow — and on the final pass that stretch never gets cut. Distance is the
  larger of two limits so both hold: the angle the tool can manage, and the
  distance covered in the time a straight plunge would have taken (jscut's idea,
  and a good one — below it the ramp is free). Ramping starts from the pass
  above, not from safe Z, and rapids down to it, since that stretch is air or
  kerf already cut.
- [x] **Lead-in / lead-out.** Tangential arc onto the start of the cut, so the
  tool is already moving along the finished edge when it reaches it. Matters
  most for vinyl with an O-flute.
- [x] **Which side the lead comes from is a PARAMETER, never a guess.** An open
  path has no interior and the program cannot know which side is scrap. Greg:
  *"we probably should have some kind of UI as well for picking where the leads
  go (its not obvious what will be considered scrap automatically)."* Nothing in
  `entry.js` tries to detect it.
- [ ] Lead placement UI — side, length, sweep, per job (Phase 4)
- [ ] **Dogbone / T-bone corner relief.** A round bit leaves a tool-radius
  fillet in inside corners; a square tenon will not seat. Least relevant under
  D17, where the kerf is the artwork rather than a part being freed, so it stays
  a per-job toggle that may never be switched on.

Measured on painted_ladies_v001.svg, 4mm stock cut 5mm in 5 passes:

| | vertical entries | lines |
|---|---|---|
| plunging | 10 | 1875 |
| ramping at 3° | **0** | 2275 |

### 1.9 Arc fitting → G2/G3 **[the biggest cut-quality win over jscut]**
`src/core/path/fit.js` refits a polyline as lines and arcs; the post-processor
emits G2/G3 with incremental I/J when given an `arcTolerance`.

By the time a toolpath reaches the post-processor it is a polyline, because
Clipper offsets polygons and knows nothing about curves — so every curve is a few
thousand chords, each an individual `G1`. That is bad in three ways and only one
is file size: the planner looks ahead a fixed number of blocks and cannot keep
the feed up through thousands of 0.05mm moves; GRBL's small serial buffer
starves; and the file is huge. An arc is one block the controller interpolates
itself, at full feed.

- [x] Greedy longest-first fit, doubling then bisecting, so a smooth curve costs
  log(n) probes rather than a quadratic scan
- [x] **Checked against the SEGMENTS, not just the vertices.** Any three points
  lie on a circle, so a fit through three points has verified nothing — and a
  right-angled corner IS three points. On Greg's skyline that turned a corner
  into a semicircle bulging **5.15mm** off the path with every vertex exactly on
  it. Each chord's sagitta is now checked. Third time this session that
  points-versus-segments has been the bug.
- [x] **The tolerance is a budget split in half.** Vertex-off-circle and
  chord-sagitta are separate contributions and they ADD; checking each against
  the full tolerance let the total reach twice it (0.0134mm measured on a 0.01mm
  tolerance, unmoved by any amount of output precision, which is how it was
  identified rather than guessed at).
- [x] Monotonic sweep, so a path that doubles back cannot masquerade as an arc
- [x] **Sweep stops short of half a turn.** At exactly pi the endpoints are
  diametrically opposite and `atan2` cannot tell +pi from -pi, so the direction
  becomes a coin flip.
- [x] Very flat arcs rejected: a huge radius is a straight line with a
  numerically delicate centre far off the work
- [x] IJK form, not R: `R` cannot express more than half a turn without a sign
  convention controllers disagree about, and loses precision badly on a shallow
  arc
- [x] **Verified by tracing the emitted G-code**, arcs interpolated the way a
  controller would, against the toolpath that was planned. That check found the
  semicircle bug; nothing else could have.

Measured on painted_ladies_v001.svg (3687 straight cuts, 71.3 KiB unfitted):

| tolerance | size | worst measured deviation |
|---|---|---|
| 0.005mm | 86% | 0.0034mm |
| 0.01mm | 61% | 0.0072mm |
| 0.03mm | 30% | 0.0200mm |

The skyline is mostly straight lines, so it is the least favourable case. On the
serpentine chirp at 0.01mm: 8466 cuts and 160.4 KiB become **17%**, deviation
0.0079mm.

### 1.10 Post-processor
`src/core/post/grbl.js` is the dialect (how a move becomes text);
`src/core/post/program.js` is the walker (what to ask for, in what order, and
safely). Swapping the dialect is how another controller, or a laser, gets
supported (D12).
- [x] Dialect interface: `preamble, postamble, comment, rapid, feed, spindleOn,
  spindleOff, dwell, toolChange`
- [x] **GRBL post**: `G21`/`G20`, `G90`, `G17`, `G94`, real `G0` for rapids,
  `M3 S…` with a spin-up dwell, `M5`, `M2`
- [x] **Rapids are `G0`, not a fast `G1`.** jscut emits `G1` at rapid feed for
  every positioning move. Those are different instructions: `G0` lets the
  controller use its own rapid profile, `G1` is a coordinated feed move the
  planner treats as cutting — and it makes a positioning move indistinguishable
  from a cut to anything reading the file back, human included.
- [x] Configurable decimal places (jscut hard-codes 4, which at 0.0001mm is
  three orders finer than a hobby router resolves and just inflates the file).
  Trailing zeros trimmed; negative zero normalised away.
- [x] **Refuses to emit a non-finite coordinate** rather than writing
  `G1 XNaN YNaN`, which is what jscut's dead tab path does
- [x] Modal output: axis words only when they change, feed only when it changes.
  Comparison is on the FORMATTED value, so two positions a nanometre apart never
  become a move.
- [x] **Invariant: never rapids in X or Y below safe Z**, enforced at the point
  of emission and asserted by reading the emitted text back. Also rejects a plan
  whose safe Z is not above every pass — the guard is stated relative to safe Z,
  so it cannot catch a safe Z that is itself in the work.
- [x] Tool-change breaks: `M5`, retract, comment naming the tool, `M0` pause,
  restart the spindle. No restart between jobs sharing a tool and speed.
- [x] `;<job name="…">` … `;</job>` breadcrumbs, with characters that would
  break the comment stripped from the name
- [x] **Round-trip test**: an independent reader in the test file parses the
  emitted text and checks the cutting moves reproduce every point of every run
  in order, at the right depth and feed. It shares no code with the emitter, so
  a bug there cannot hide behind a matching bug in the check.
- [x] `lab/gcode.mjs` runs the whole pipeline: SVG → offset → tabs → passes →
  `.nc`. Greg's skyline at 3.175mm, 4mm stock cut 5mm in 5 passes: 3746 lines,
  45 rapids, 22 plunges, 71 KiB.
- [ ] Stub post for `ncviewer.com` dialect differences if any surface during verification

### 1.11 G-code parser (test oracle, not pipeline)
`src/core/post/parse.js`. Nothing needs it to MAKE G-code; it exists so the
output can be read back the way a controller would. That has already earned its
keep — arc fitting passed every unit test on synthetic curves and then bulged
5.15mm off a right-angled corner on real artwork, and tracing the emitted file
is what found it. Deliberately shares no constants, formatting or geometry with
the emitter: a parser built from the emitter's own parts would agree with it
about a mistake.
- [x] Structure taken from NCviewer's `parseGCode()` — its modal state machine is
  the right shape
- [x] Fixed: **full circles silently dropped** (coincident endpoints with IJK is
  exactly how a full circle is written, and a zero sweep is exactly the wrong
  reading of it); **G18/G19 pair I/J/K with the wrong axes**, sending the arc
  somewhere else; **the `R` form ignores its sign**, where negative means the
  major arc — the long way round; **any line with a G-word emits a move**, so
  `G21` alone becomes a zero-length move
- [x] Added: **G20/G21** (absent entirely upstream, so an imperial file reads
  25.4× too small), G90/G91, both comment forms including inline `(...)`,
  spindle and tool tracking, per-move source line numbers
- [x] `flattenMoves` interpolates arcs to a chord tolerance, for drawing
- [ ] G54–G59 work offsets

### 1.12 Verification harness
- [x] **Round-trip property test**: the emitted program is parsed back,
  interpolated, and the traced motion compared against the toolpath that was
  planned. Holds within the arc tolerance across straight, curved and mixed
  geometry, in millimetres and inches. This is the check that has caught what
  unit tests did not.
- [x] `lab/gcode.mjs` runs it on every invocation and prints the worst deviation
- [x] `lab/simulate.mjs` draws a `.nc` file the way a controller would run it,
  knowing nothing about how it was made. Arcs are coloured separately on purpose
  — one that has gone somewhere it should not appears as a violet bulge rather
  than hiding among identical green lines. Greg: *"once we have it actually
  working and simulating if there's any weirdness with the arcs it will reveal
  itself."*
- [ ] Feed-rate and machine-limit checks
- [ ] Golden-file comparison against known-good output

## Phase 2 — App shell

Goal: the window layout, themed, persistent, with a working visibility/render
driver. Dummy window contents.

- [x] Mount `vue-win-mgr` with the default layout: Outliner over Inspector in a
  left column, the main tab group (Workspace · Preview3D · Preview2D · Code ·
  Settings) filling the rest, Timeline as a strip beneath it. Header bar and
  status bar in the manager's slots, so neither can be closed or tabbed away —
  which matters most for "reset layout", the escape hatch that has to survive
  whatever the user did to need it.
- [x] **Every window registered with an EXPLICIT slug.** An auto-derived slug
  comes from the build-time component name; minification renames it, so a layout
  saved before a release stops matching the windows in the release and the user
  opens the app to a layout that silently drops half its panels. A slug may
  never change once shipped — rename the title, which is what people read.
- [x] Theme: one set of ROLES driving both `vue-win-mgr`'s flat theme prop and
  `vue-settings-panel`'s grouped CSS variables. Left as two palettes they drift.
  Light + dark, verified in a real browser: `--gg-surface` and `--mc-bg-color`
  are the same colour, not two colours that resemble each other.
- [x] Layout persistence to localStorage, debounced 400ms, **versioned** (a
  layout from an older build can restore an app the user cannot repair from
  inside the app) and **validated against this build's slugs**. A flush on
  `beforeunload`, since the change still inside the debounce when the app quits
  is exactly the one just made.
- [x] "Reset layout" in the header bar
- [x] **Single app-level rAF driver**, provided not imported. Skips callbacks
  whose window is not visible and stops requesting frames entirely when none
  are. The reason it exists: a hidden browser TAB is throttled to about 1fps, a
  window hidden behind a tab INSIDE the manager is not, so a Three.js view in a
  background tab keeps rendering at 60fps into a canvas nobody can see.
  Deliberately framework-free so it can be tested against a fake clock.
- [x] `useVisible()` wrapping `windowCtx.isVisible`, with an
  `IntersectionObserver` fallback and a `source` saying which is in use. The
  tempting fallback is "assume visible", which restores exactly the problem the
  flag prevents while looking fine — the only symptom is a warm laptop, which
  nobody reports as a bug.
- [x] `useResize()` — refuses 0×0 rather than passing it on. A hidden element
  reports zero, `setSize(0,0)` gives an aspect of NaN, a projection matrix of
  NaN, and a scene that silently vanishes and never returns, because nothing
  recomputes it: the size did not change, it was wrong once. Also clamps the
  device pixel ratio, since a 3× buffer costs nine times the fill rate of a 1×
  one and this has to stay usable on a 2017 MacBook.
- [x] `useRenderLoop()` — joins a view to the driver AND wakes it on becoming
  visible. Without the wake the loop never starts at all: views register during
  setup, before anything is laid out, so everything reports hidden, the driver
  correctly declines to schedule, and nothing asks again.
- [x] **Verified in a browser, not just in tests.** Over the same 1.5 seconds a
  hidden window gained **0** frames and the visible one gained **109**.
- [x] `onSerialize` / `onLayoutLoad` rider state per window, via
  `useWindowState`. The substance is not the hooks, it is that **restored state
  is untrusted input**: it survived an upgrade, a user can hand-edit it, and an
  older build may have meant something different by a field. A saved `"1"`
  multiplies into a string; a saved `NaN` survives every operation and surfaces
  as a blank view several layers away. A value is accepted only when it matches
  the TYPE of the default it replaces, and numbers must be finite; anything else
  falls back silently, which is the correct response to a field we cannot make
  sense of.
- [x] Verified in a browser: switch a tab, let the debounce settle, reload —
  layout restored (5 frames) and the window's own state came back with it.
- [x] **Settings window mounting `vue-settings-panel`** — installed from npm
  (`^0.0.5`); the sibling clone was only ever reference. The spec lives in
  `settings/spec.js` as data so the defaults can be asserted, and only
  APPLICATION settings go in it — stock thickness or work zero carried between
  projects is how a 4mm job gets cut at 18mm depths.
- [x] The palette drives the panel too, via its `themeColors` prop.

**Two bugs here, both the same shape, and both found by looking rather than by
testing.** `palette.js` had invented a set of `--lc-*` / `--mc-*` CSS variables
from a description of how the library themes itself, and a test asserted they
agreed with our own variables. They did agree. The library never reads them — it
takes a nested object. Then the settings spec passed `{label, value}` objects to
a Select, and its test read `options.map(o => o.value)` — the same wrong shape —
so it passed while the panel rendered `{ "label": "Millimetres", "value": "mm" }`
into the field. **A test that encodes the same assumption as the code it checks
confirms they agree, not that either is right.** Both are now checked against the
library itself: the theme against its exported `defaultTheme` keys, the spec
through its own `createSettings`.

**Note on `vue-win-mgr`:** it stays a `file:` dependency. The npm release does
not yet carry the `isVisible`, `onVisibilityChange` and `layout-changed` patches
this app is built on, so switching to the published version would silently break
the render driver and layout persistence.

**Also worth knowing:** `vue-settings-panel`'s stylesheet is 2.5MB, of which
2.42MB is ten base64-embedded fonts. It takes the app's CSS from 86KB to 2.59MB.
Nothing here is broken by it, and in Electron it loads from disk, but it is
parsed at every start and it inflates the package.

**Verified by building the renderer and rendering it in a real browser**, which
is the only thing that catches the failure below.

## Phase 3 — Data model, undo, project I/O

Goal: the spine everything else hangs off. Get this wrong and undo can never be
retrofitted.

### 3.1 Command system **[do this first, before any mutation exists]** — done

- [x] Command interface: `{ label, touches, apply(state), coalesceKey? }`. **Not
  `revert`.** An inverse per command uses the least memory of anything, and it is
  the half that is never exercised while you work — an incomplete `revert` does
  not fail, it leaves the document slightly wrong and you find out several
  operations later with nothing left to inspect. Instead a command declares which
  subtrees it will change; the dispatcher copies them before `apply` and again
  after, and undo and redo are both a restore. Nobody writes an inverse, so
  nobody writes a wrong one.
- [x] `touches` earns its keep twice: it is also exactly the set of nodes whose
  G-code is stale, so the per-job cache invalidation in 5.2 comes free instead of
  being a second thing to keep in step.
- [x] **The one way this design can be wrong is a command that changes something
  it did not declare**, so `verify` mode does the round trip for real on every
  dispatch — copy the document, run `apply`, put the before-snapshot back, and
  diff. An under-declared command throws at the point of the mistake, naming the
  paths. On in tests, off in production. Tested by making the mistake on purpose.
- [x] Dispatcher owns the only write path into the store. Components never mutate directly
- [x] Undo/redo stacks, depth-limited, cleared on project load
- [x] Coalescing: a drag collapses into one entry while the `coalesceKey` holds and
  the entry is unsealed, keeping its ORIGINAL before-snapshot so undo reaches back
  to where the drag started. `seal()` on mouse-up or blur is the mechanism; the
  time window is only a net for the places that forget to call it.
- [x] Command commit is also the **G-code regen trigger** — one `onCommit` per
  committed command, so a forty-move drag is one regeneration and debouncing is
  not a separate mechanism
- [x] **Redo restores rather than re-running `apply`.** Re-running would be
  cheaper and would also make every command have to be a pure function of the
  state — no fresh uuids, nothing read from outside — because a redo that mints a
  different id leaves every reference to the first pointing at nothing.
- [x] Selection changes are not commands (clicking around must not fill the undo
  stack), but every command captures the selection before and after, so undoing a
  delete gives back the node AND the selection you had. That is why selection
  lives in the store rather than in a component.
- [x] Tests: 51 of them, including random sessions of structural edits across 40
  seeds — apply, undo all the way back, and diff against the start; and undo *k*,
  redo *k*, and diff against where it was. With `verify` on throughout.

**Two things measured rather than assumed.** `structuredClone` throws
`DataCloneError` on a Proxy, and the state will be a Vue `reactive()` proxy the
moment 3.2 wires it in — so snapshots use a hand-written walk that sees through
the traps, and refuses anything that is not plain data rather than quietly
returning `{}` for a `Date`. And the first version of the random-session test
produced exactly **one** coalesce in 2143 commands, so the round-trip claims
barely covered coalesced entries; a coalescing command now dispatches as a run,
the way a drag actually arrives.

**Every claim above was mutation-tested**: restoring subtrees one at a time
instead of in two passes, coalescing clobbering its `before`, the depth limit
trimming the wrong end, `seal()` doing nothing, and the `verify` diff short-
circuited. Each one fails tests that name it.

### 3.2 Project store — done

**Reactivity is shallow throughout** — `shallowRef` / `shallowReactive`, never
`ref` on an object and never `reactive`. Greg's standing convention, and it fits
3.1 rather than fighting it: deep proxies break `structuredClone`, destroy object
identity, get stored by every library handed one, and cost per property access on
data that is toolpaths with tens of thousands of points. Shallow means
reactivity triggers on replacement rather than mutation, so the store has to say
what changed — which `touches` already does. That one list now does three jobs:
snapshot for undo, invalidate G-code (5.2), and replace the node refs. Per-node
reactivity, exact, no proxies. Written up in `src/renderer/CONVENTIONS.md`.

- [x] Store is a **factory, not a singleton**, keyed by project id — this is the whole cost of leaving the door open for multi-project tabs (Stretch 2), and it's near zero if done now
- [x] `nodeRef(id)` hands out a `shallowRef` per node; after every commit the store
  republishes the refs for the nodes a history entry actually touched, taken from
  the union of its before and after snapshots. Selection, `revision`, `dirty`,
  diagnostics and the undo labels all fall out of the same publish
- [x] `load()` refills the document IN PLACE rather than swapping the object, so
  every caller holding `store.document` keeps working — and clears the history,
  because one undo across a load would splice the previous project into this one
- [x] **A correction worth keeping.** Mutating the store to republish *every* ref
  on every commit broke no test. It is not a regression: `shallowRef` compares
  with `Object.is`, and an untouched node is still the same object, so the
  assignment is a no-op. Object identity is what makes this fine-grained — the
  touched set is what makes it CORRECT, because undo and redo restore clones, so
  every node inside a restored subtree is a new object and a view that is not
  republished holds the detached original forever with no error. Publishing only
  the ids named in `touches`, rather than their whole subtrees, is the real bug,
  and it now fails four tests
- [x] Node types: `Project`, `Folder(Jobs|SVGs|References)`, `Tool`, `Job`, `Tab`, `SvgDoc`, `SvgPath`, `ReferenceImage`, `WorkMaterial`
- [x] Every node: stable uuid, `name`, `locked`, `visible`. Lock and visibility are
  inherited DOWNWARDS and derived, never written into the child — so unhiding a
  folder brings back exactly what was showing before
- [x] Tree ordering is meaningful for `Jobs\` (emission order) and cosmetic elsewhere.
  `cuttingOrder` is a straight walk of the tree; nothing sorts or optimises
- [x] Selection state (multi-select, active node), in the document so undo restores it
- [x] **No `parent` field.** The tree is `children` arrays and nothing else; a
  parent is derived. Two copies of the tree is two things to keep correct, and
  the derived one is not the copy that goes wrong
- [x] **Geometry lives outside the document.** An SvgPath holds a geometry id, not
  points. Undo copies the subtrees a command touches, so points in a node would
  mean cloning 40,000 numbers to record that a path was renamed. Geometry is
  immutable and keyed, so changing it means pointing at a new id — which undo
  restores for free. Unreferenced entries are collected on SAVE, never on undo:
  the entry an undo just orphaned is the one its redo wants back
- [x] `validateTree` for shape (dangling children, orphans, a Job outside a Tool,
  a reference to a deleted path) — separate from schema validation, which is
  values. They fail for different reasons at different times
- [x] Commands for every edit, with `touches` correct and proven by `verify`

### 3.3 Settings tiers (D7) — done

- [x] **Document/machine** on the Project node: workspace size · work zero · safe Z ·
  material thickness · **cut-through allowance** · rapid rate · tool change ·
  spindle dwell · default tab length and depth. *Display units and G-code decimal
  places deliberately stay APPLICATION settings: they change how a number is
  shown, not what gets cut, and carrying a presentation choice between projects
  is harmless where carrying a material thickness is not. plan.md listed display
  units here; this is a deliberate departure.*
- [x] **Tool**: diameter · angle · flute count *(physical, so no Job field exists to
  override it — an invariant the field table is tested for)* · pass depth ·
  stepover · plunge rate · cut feed · spindle RPM
- [x] **Job**: paths · cut depth · operation · margin · band width · combine ·
  direction · offset side and heading · ramp · lead-in/out · dogbones · **plus
  overrides of pass depth, stepover, plunge rate, cut feed and spindle RPM**
- [x] **Live-linked inheritance**, not copy-at-creation. ABSENT means inherited —
  which is why `createNode` leaves inheritable fields out rather than filling in
  the default. A job carrying `passDepth: 1` looks identical to an inherited one
  and behaves completely differently six months later
- [x] `resolveField` returns the value AND its provenance, so the Inspector's
  inherited state and reset button come from one call. Reset deletes the key,
  restoring the LINK — writing today's tool value into the job would look the
  same and be wrong the next time the tool is corrected
- [x] `dependentsOf` answers the other direction: which jobs a tool's value is
  actually reaching. Needed for staleness in 5.2
- [x] **One field table drives everything**: defaults, the Valibot schema, what
  inherits, and what the Inspector renders. Written by hand in four places is
  four places to drift — jscut's six unit dropdowns and its `makeAllSameUnit()`
  are what that looks like at the end

### 3.3a Diagnostics — new, and the reason 3.3 changed shape

Cut depth is an explicit number and **nothing recalculates it** when the material
changes. Greg's call, over my recommendation of a derived "through" mode, and the
right one: a depth that moves under you is a depth you cannot trust.

That needs something to make a change of stock visible, and D17 rules out the
obvious thing. The kerf IS the artwork — a cut that does not reach through is
most of what this program is for, so flagging it teaches you to ignore flags. So
diagnostics have three levels, and the interesting one is the quiet one:

- **info** — what will happen, always shown, never coloured like a problem.
  "Cuts 1.00mm of 4.00mm — 3.00mm left below." Change the stock from 4mm to 18mm
  and twelve jobs that read "through" now read "13.00mm left". *That sentence
  changing is the entire notification mechanism.* Nothing had to shout.
- **warning** — probably not meant, and the machine will still do it: past the
  cut-through allowance into the spoilboard, two tabs overlapping into one, a tab
  as deep as the cut it is supposed to break.
- **error** — no toolpath can be made. Blocks export (5.4): no paths, no depth,
  no diameter, safe Z at or below the surface, an operation that needs a closed
  path on an open one.

Deliberately **not** reported, and tested for: a through cut with no tabs (both
halves may be clamped; "is the part held" is the wrong question when nothing is
being freed), detail finer than the bit, a pass depth larger than the cut depth.

### 3.4 Project file I/O
- [ ] `.gollyg` zip container: `project.json` + `assets/` (reference images) + `svg/` (originals verbatim, so they stay re-importable)
- [ ] Schema version field + migration hook from day one
- [ ] New / Open / Save / Save As, wired to Electron `dialog` via `ipcMain.handle` (the template's fire-and-forget `send` channel can't return a path — this needs the `invoke`/`handle` pattern)
- [ ] macOS `open-file` event + `CFBundleDocumentTypes` so double-clicking a `.gollyg` works *(deferred with D1, but the file association is cheap to declare now)*
- [ ] Recent files
- [ ] Dirty tracking + "unsaved changes" prompt on close

### 3.5 Outliner window
- [ ] Fixed top-level hierarchy: `Project > Jobs\ > Tool\ > Job > Tab`, plus `SVGs\ > SvgDoc > SvgPath`, `References\`
- [ ] Lock + eyeball toggles at every level, inherited down
- [ ] Drag to reorder within `Jobs\`, and to move jobs between Tool groups (one drag implementation serves both — no move-up/down buttons needed)
- [ ] First job auto-creates a default Tool group
- [ ] Import SVG button (multi-select), Import Reference button, New Tool button
- [ ] **Multi-select in the outliner**, with the Inspector showing the shared fields
  of a mixed selection. Needed for the next item; identified as a gap during the
  Phase 1.3 lab review.
- [ ] Rename in place; provenance label shown on jobs
- [ ] Context menus (`@imengyu/vue3-context-menu` ships with `vue-win-mgr` already)

### 3.6 Inspector window
- [ ] Scratch-built framework: group headers (full width) + two-column rows (label / control)
- [ ] Control set: number+unit, slider+number, select, toggle, color, vector2, angle dial, text, read-only
- [ ] Valibot validation, inline errors, blocked commit on invalid
- [ ] Per-node-type layouts driven by the schemas from 3.3
- [ ] Inherited-value visual state + reset button
- [ ] Action buttons: **Create Job from Path**, **Use Path as Work Material**, **Add Tab**, **Calibrate Scale**, **Detach**, **Set Tool Width**
- [ ] **Create Job from PathS** (multi-select) with a Combine mode — Union / Intersect /
  Difference / XOR, the same set jscut offers. Union matters for real work: three
  overlapping circles cut separately re-cut air where earlier circles already
  cleared it. Combining must always be an explicit per-job choice; the importer
  never merges shapes on its own.

---

## Phase 4 — Workspace (SVG/DOM)

- [ ] Root `<svg>` with pan/zoom via a transform on a root `<g>`; zoom to fit, zoom to selection
- [ ] **One `<path>` element per object, never per segment** — a 50k-command `d` is fine, 50k sibling elements is not
- [ ] **Drag via CSS `transform` on a wrapper `<g>`; commit path data only on release.** Re-serializing a large `d` every mousemove is the one way to make SVG feel slow here
- [ ] `vector-effect: non-scaling-stroke` on dashed source paths — but **not** on the tool-width outline, which represents real physical width and must scale
- [ ] Render layers, back to front: grid · reference images · work material · SVG paths (thin, random colors, Illustrator-wireframe style) · toolpaths (dashed centerline + tool-width round-cap/round-join outline) · tabs (hatched) · gizmos · puck
- [ ] **Selection cycling**: `document.elementsFromPoint()` returns the hit stack in z-order; advance an index when the click is within ~3px of the previous one, wrap at the end. Blender behaviour, essentially free
- [ ] Selected state: thicker stroke + dashed bounding box
- [ ] Gizmos: translate, rotate, scale (uniform + per-axis), all emitting coalesced commands
- [ ] **Travel-move layer** — render the lifts and rapids between cuts, not just
  the cutting, so the effect of ordering is visible rather than argued about.
  Greg's request; prototyped in `lab/link.mjs`. Toggleable, since it clutters.
- [ ] **Heading knob** for open-path offset System A — draggable radial line + numeric angle field
- [ ] **Tab dragging** along the path (constrained to arc length)
- [ ] **0,0 puck** shown when the Project is selected; dragging it re-bases all emitted coordinates
- [ ] Grid: `<pattern>`-based, configurable spacing, labeled in display units
- [ ] Reference images: place, rotate, opacity, and **Calibrate Scale** — drop two pins, enter the real-world distance between them, solve the scale factor, then lock scale (rotate/translate still allowed)
- [ ] Locked items are not hit-testable (`pointer-events: none`); hidden items are not rendered
- [ ] *(if a single toolpath ever exceeds ~100k points: decimate for display only — emitted G-code stays full fidelity. Not a v1 problem, flagged so it isn't a surprise)*

---

## Phase 5 — Codegen wiring + Code editor

- [ ] Move `cam-core` into a Web Worker with `AbortController`-style cancellation
- [ ] **Per-job G-code cache**, invalidated per node — regenerate only the changed job's block and re-splice
- [ ] Debounce driven by command commits (already free from 3.1)
- [ ] Staleness contract: status bar shows idle / queued / generating / **stale**; Export is blocked until current
- [ ] Monaco, **lazy-loaded on first open of the Code window** (it's several MB of JS to parse — don't pay it at boot). ESM entry + Vite `?worker` wiring, *not* the CDN AMD loader NCviewer uses
- [ ] G-code language: Monarch tokenizer (G/M codes, axis words, parameters, comments), hover info for common codes, bracket-matching on `;<job>` breadcrumbs
- [ ] **Read-only by default**, with an explicit "Edit G-code" toggle that suspends auto-regen — otherwise hand-editing and live regen fight and the user loses work
- [ ] Export button in the window's toolbar → `.nc`/`.gcode` via Electron dialog
- [ ] Line ↔ job mapping from the breadcrumb comments

### ▶ MVP LINE — everything above this can cut real material ◀

At this point: import an SVG, place jobs, set tools and feeds, add tabs, generate
verified G-code, export it, run it. Verify on ncviewer.com until Phase 8 lands.

---

## Phase 6 — Preview2D

- [ ] Canvas2D, sized in real units with an explicit px-per-mm setting (so PNG export is dimensionally meaningful)
- [ ] Base fill: work material shape if defined, else the whole workspace
- [ ] Paint strokes in **chronological cut order** at tool width, round cap + round join
- [ ] Above material bottom → `source-over` in the depth-gradient colour (deeper naturally overwrites shallower)
- [ ] At/through material bottom → that stroke goes to a **separate through-cut mask canvas**, applied as one final `destination-out` composite. (Doing `destination-out` inline risks a later job's `source-over` painting colour back into an existing hole)
- [ ] Configurable depth gradient in settings
- [ ] `toBlob()` PNG export
- [ ] Independent zoom/pan; grid overlay in display units

---

## Phase 7 — Timeline

- [ ] Own window, horizontal, bottom
- [ ] Global time state shared across all views (2D, 3D, code) — views zoom independently, time does not
- [ ] Transport: play / pause / stop / step / reverse / speed multiplier
- [ ] Scrub bar
- [ ] **Real time model**, not NCviewer's segment-index slider: integrate `distance / feedrate` per move so playback matches real cut duration. Show estimated job time — genuinely useful on its own
- [ ] Driven by the Phase 2 rAF driver
- [ ] Code editor highlights the current line during playback
- [ ] Per-job coloured regions along the timeline

---

## Phase 8 — Preview3D

Written fresh. NCviewer is reference only — it's one 1187-line inline script
with zero exports, all deps CDN-loaded, no grid, no units handling at all, and
no animation (just an index slider).

- [ ] Own `WebGLRenderer` per mounted window, sharing one `Scene` *(note: sharing a Scene shares CPU-side objects but **not** GPU buffers — three uploads geometry per context. Irrelevant at 2–3 views, don't expect memory savings)*
- [ ] Build geometry directly from toolpaths — **no G-code parsing in the render path** (D2)
- [ ] Rapids vs cuts by vertex colour
- [ ] Z-up, orthographic + perspective toggle, OrbitControls per view, view gizmo
- [ ] **Configurable labeled grid in display units** — NCviewer has none
- [ ] **Animated tool**: a cylinder (or cone for a V-bit) travelling the path, driven by Timeline time
- [ ] Progress colouring: cut / current / not-yet-cut. **Use a per-vertex progress attribute + a uniform cutoff**, not NCviewer's approach of re-uploading the entire colour buffer on every slider event
- [ ] Optional stock block, work zero indicator, axis lines
- [ ] Click a segment → select its job and jump the code editor to that line
- [ ] Dispose properly in `onUnmounted` (fires on close, `setKind`, and any `loadLayout`)

---

## Phase 9 — Stretch

- [ ] **G-code round-trip.** Parse `;<job name="…" …>` breadcrumbs back into Outliner nodes with populated Inspector props, so a `.nc` file is importable without its `.gollyg`. (The breadcrumbs themselves ship in 1.10 regardless — they earn their keep for the Timeline and editor linking alone.)
- [ ] **Multi-project tabs.** Header-bar tab strip, separate from the windowing system's tabs. The store factory from 3.2 is the only structural prerequisite
- [ ] **V-carve** (D15) — needs medial-axis/Voronoi; `Z = -distance / tan(angle/2)`
- [ ] Chipload / feeds-and-speeds calculator from tool flute count + material
- [ ] Tool library persisted across projects
- [ ] Upstream the `vue-win-mgr` patches from 0.3 and publish
- [ ] Old-hardware branch (D1)

---

## Open questions

Nothing blocking, but these want answers before the phase that needs them:

1. **Text-to-path library** (1.1) — opentype.js works in Node so tests can cover it; the browser's own text measurement doesn't. Leaning opentype.js. Font file handling in a `.gollyg` is the wrinkle.
2. **Clipper binding** (0.6 spike) — must be answered before 1.3.
3. **Work material in 3D** — currently 2D-only by design. Revisit at Phase 8?
4. **Does ncviewer.com disagree with GRBL anywhere** that matters? Worth a deliberate comparison once 1.10 lands, since it's the verification path.
