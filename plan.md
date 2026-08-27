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
- [x] **System A: heading offset.** Displace the whole path along one fixed angle. Trivial geometry; the work is the UI knob (Phase 4)
- [x] **System B: path-normal offset.** Compute the 2D normal at every point and displace along it. Self-intersects on concave curves, spreads on convex ones
- [x] **Side A / side B** selector
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
- [x] **One side is an ARRAY of paths, not one path.** A one-sided offset is only
  continuous when the source is well behaved. Deep valleys narrower than twice the
  offset, or a path drawn to retrace its own ground, genuinely split it into
  disconnected pieces with a lift between them. Keeping only the longest run lost a
  quarter of Greg's skyline and most of his houses.
- [x] **Membership is judged per EDGE, not per vertex** — the same mistake as the
  "clean" slider above, in a second disguise. Where a spur meets the run it grows
  from, the outline corner sits exactly equidistant from both source segments and
  the tie is broken by whichever the index reaches first. One vertex tagged for the
  far side severs the run there: 112mm of 168mm lost, with every individual
  measurement correct. An edge's midpoint has no such tie, and its clearance is the
  worst of the midpoint and both endpoints, which also rejects the butt-cap corner
  that sits *inside* the offset where the source curves back near its own end.
- [x] **Runs are dropped by LENGTH, never by point count.** The offset of a straight
  line is a rectangle whose side is one edge between two vertices, and 100mm of cut.
  Threshold is the arc chord at that offset — the resolution the outline is
  described at.
- [ ] Both systems composable (heading + normal at once)
- [x] **Visual test page** in `dev:lab` with pathological inputs: tight S-curves, cusps, near-180° reversals, a spiral, a zigzag with corners tighter than the tool
- [ ] ~~Fallback if the distance-filter approach fails~~ — taken; this IS the
  implementation now.

### 1.6 Toolpath linking & ordering
Port the one genuinely clever idea in jscut (`js/Cam.js`).
- [ ] `mergePaths` — greedy nearest-neighbour ordering over path endpoints
- [ ] `crosses(bounds, a, b)` test — if the connector between two loops stays inside already-cleared material, concatenate them into one continuous path instead of retracting
- [ ] `safeToClose` flag → skip retracts between depth passes when the closing chord stays in bounds
- [ ] Inner-before-outer ordering (or parts fall out mid-job)
- [ ] Replace jscut's O(n²)-over-every-point search with endpoint-only + a spatial index
- [ ] **Drop cut fragments not worth a plunge.** `openOffset` keeps every piece its
  geometry justifies, down to fractions of a millimetre, because a geometry module
  has no business deciding what is worth cutting. Linking DOES know the tool: a
  piece shorter than the cutter diameter removes nothing the plunge has not already
  removed, and costs a lift, a rapid, a plunge and a retract to do it. Measured on
  the painted-ladies skyline at a 3.175mm tool: pieces of 0.3, 0.4 and 0.5mm.

### 1.7 Tabs (holding tabs)
jscut's are broken: `separateTabs` lives in a gitignored emscripten blob whose
CDN fallback is dead, and the JS fallback path has a return-type bug that emits
`G1 XNaN YNaN`. We do it differently and in pure JS.
- [ ] Tab anchored as **normalized arc-length position on the source path**
- [ ] **Resolved onto the offset toolpath at generation time** by nearest-point projection — so changing tool diameter never drifts a tab
- [ ] Per-tab: depth, length along path (real units, not % — the jscut complaint)
- [ ] Splitting a toolpath into alternating over-tab / free spans, with correct Z transitions
- [ ] Tabs suppressed on passes shallower than tab height
- [ ] Tests: tab count/position stable across tool-diameter changes

### 1.8 Quality features jscut lacks
- [ ] **Dogbone / T-bone corner relief.** A round bit leaves a tool-radius fillet in inside corners; a square tenon won't seat. Detect corners below an angle threshold in the offset path, insert a corner arc. Per-job toggle + style picker
- [ ] **Lead-in / lead-out.** Tangential entry arc so the plunge happens in scrap rather than dwelling on the finished edge (this one likely matters most for vinyl with an O-flute)
- [ ] **Ramp plunge** — port jscut's time-budget ramp: walk forward along the path until round-trip distance exceeds `cutFeed × (Δz / plungeFeed)`, interpolate Z over the there-and-back

### 1.9 Arc fitting → G2/G3 **[the biggest cut-quality win over jscut]**
jscut never emits an arc. Everything is flattened polylines, which makes GRBL's
look-ahead planner decelerate through curves.
- [ ] Fit circular arcs to flattened runs within tolerance (biarc or least-squares + validation)
- [ ] Emit `G2`/`G3` with `I`/`J`, correct for the active plane
- [ ] Tolerance is a project setting; must be able to disable entirely
- [ ] Tests: fitted arc deviation asserted ≤ tolerance; file-size reduction measured

### 1.10 Post-processor
- [ ] Interface: `{ preamble, rapid, feed, arc, spindleOn, spindleOff, setRPM, toolChange, dwell, postamble }`
- [ ] **GRBL post** (the real target): `G21`/`G20`, `G90`, `G17`, real `G0` for rapids (jscut wrongly uses `G1` at rapid feed for everything), `M3 S…` / `M5`, `M2`
- [ ] Tool-change breaks between Tool groups: `M5`, retract, `M0` pause with a comment naming the next tool
- [ ] Configurable decimal places (jscut hard-codes 4)
- [ ] `;<job name="…">` … `;</job>` breadcrumb comments around each job's block — needed for Timeline line-mapping, editor highlighting, and the stretch-goal round-trip
- [ ] Stub post for `ncviewer.com` dialect differences if any surface during verification

### 1.11 G-code parser (test oracle, not pipeline)
- [ ] Port `parseGCode()` from NCviewer (`index.html` lines 617–786 — the one genuinely reusable, DOM-free piece in that repo)
- [ ] Keep its clever bit: auto-detect IJK absolute-vs-incremental from the first arc's radius consistency
- [ ] Fix its bugs: full circles are silently dropped; G18/G19 arc centres swap I/J/K; `R`-form ignores sign; any line with a G-word emits a degenerate zero-length move
- [ ] Add what it lacks: **G20/G21 units** (absent entirely), G54–G59 work offsets, spindle/M-codes, tool changes

### 1.12 Verification harness
- [ ] **Round-trip property test**: `render(toolpath) ≈ render(parse(emit(toolpath)))` within tolerance. If this holds, the post-processor is provably correct
- [ ] **Geometric verifier**: rasterize the swept tool volume and assert removed material matches the intended region. Catches wrong offset side, missed pass, tab at wrong depth — things a byte-diff never would
- [ ] Golden-file tests for emitted G-code (catches formatting regressions only — the verifier catches real bugs)
- [ ] Use jscut's checked-in `test.svg` as an import fixture

> **Phase 1 exit criteria:** `npm test` green, and a CLI script turns an SVG into
> G-code that renders correctly on ncviewer.com. No UI required.

---

## Phase 2 — App shell

Goal: the window layout, themed, persistent, with a working visibility/render
driver. Dummy window contents.

- [ ] Mount `vue-win-mgr` with the default layout:
  - Header bar (not a window): File menu, save/load, reset layout, project tabs later
  - Left column ⅓: Outliner (top) / Inspector (bottom)
  - Right column: tab group ~85% (Workspace · Preview3D · Preview2D · Code · Settings), Timeline below
  - Status bar: tooltip text, sim time, **codegen status** (idle / queued / generating / stale) as a small progress strip, Blender-style
- [ ] Register all window types with **explicit slugs** (auto-derived slugs come from build-time component names and break under minification)
- [ ] Theme: one reactive palette driving both `vue-win-mgr`'s flat `--theme-*` and `vue-settings-panel`'s grouped `--lc-*`/`--mc-*`. Light + dark presets
- [ ] Layout persistence to localStorage via the new `@layout-changed` event, debounced
- [ ] "Reset layout" in the header bar
- [ ] **Single app-level rAF driver.** Views register a render callback; the driver skips callbacks whose window `isVisible` is false, and stops requesting frames entirely when none are live. This is what keeps hidden tabs from burning CPU — the window manager does not throttle them, unlike a background browser tab
- [ ] `useVisible()` composable wrapping `windowCtx.isVisible`, with an `IntersectionObserver` fallback if the patched build isn't present
- [ ] `useResize()` composable — guard against 0×0 (hidden `display:none` elements report zero, and a naive `setSize()` produces a NaN projection matrix)
- [ ] Settings window mounting `vue-settings-panel`: default units, theme, grid defaults, decimal places
- [ ] `onSerialize` / `onLayoutLoad` rider state per window (zoom level, scroll position, camera pose)

---

## Phase 3 — Data model, undo, project I/O

Goal: the spine everything else hangs off. Get this wrong and undo can never be
retrofitted.

### 3.1 Command system **[do this first, before any mutation exists]**
- [ ] Command interface: `{ label, apply(state), revert(state), coalesceKey? }`
- [ ] Dispatcher owns the only write path into the store. Components never mutate directly
- [ ] Undo/redo stacks, depth-limited, cleared on project load
- [ ] Coalescing: a gizmo drag emits **one** command on mouse-up, not one per mousemove
- [ ] Command commit is also the **G-code regen trigger** — this is why debouncing comes free
- [ ] Tests: apply/revert round-trip returns identical state for every command type

### 3.2 Project store
- [ ] Store is a **factory, not a singleton**, keyed by project id — this is the whole cost of leaving the door open for multi-project tabs (Stretch 2), and it's near zero if done now
- [ ] Node types: `Project`, `Folder(Jobs|SVGs|References)`, `Tool`, `Job`, `Tab`, `SvgDoc`, `SvgPath`, `ReferenceImage`, `WorkMaterial`
- [ ] Every node: stable uuid, `name`, `locked`, `visible`
- [ ] Tree ordering is meaningful for `Jobs\` (emission order) and cosmetic elsewhere
- [ ] Selection state (multi-select, active node)

### 3.3 Settings tiers (D7)
- [ ] **Document/machine**: display units · workspace size · work zero (puck) · safe Z · material thickness · **cut-through allowance** · rapid rate · tooling type
- [ ] **Tool**: diameter · angle · flute count *(not overridable — physical)* · default pass depth · stepover · plunge rate · cut feed · spindle RPM
- [ ] **Job**: cut depth · operation · margin · combine · direction · ramp · tabs · lead-in/out · dogbones · **plus overrides of any Tool default**
- [ ] **Live-linked inheritance**, not copy-at-creation. Change a Tool's cut feed and every non-overridden job follows immediately
- [ ] Inherited fields render in the distinct (yellow) state with a "uses tool value" tooltip; the reset button restores the *link*, not just the value
- [ ] Valibot schema per node type, driving both Inspector rendering and validation

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
