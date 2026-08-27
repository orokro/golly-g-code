# `src/core` conventions

Rules that hold everywhere below this directory. Breaking one of these is a bug
even if nothing fails immediately, because the failure will surface somewhere
else entirely — usually as material cut in the wrong place.

## 1. This code is headless

`src/core` never imports Vue, never touches the DOM, and never reaches into the
application layer. It runs in three places: Node (for vitest), a Web Worker (for
non-blocking code generation), and the renderer's main thread (for cheap
synchronous queries). Enforced by lint rules in `eslint.config.js`.

Dependencies point inward only: `renderer → core`, never `core → renderer`.

## 2. Internal units are millimetres, always

Every number crossing a function boundary inside `src/core` is in **float64
millimetres**. There is no "current unit" state and no per-module unit setting.

jscut got this wrong in an instructive way: it had six independent unit dropdowns
(material, tool, tabs, each operation, G-code output) and a `makeAllSameUnit()`
helper to paper over the resulting mess. The lesson is that the display unit is a
presentation concern and belongs nowhere near the geometry.

Conversion happens at exactly **three** boundaries, and nowhere else:

| Boundary | Direction | Where |
|---|---|---|
| SVG import | document units → mm | `core/svg` |
| Clipper integer scaling | mm → scaled integers → mm | `core/geometry` |
| G-code emission | mm → display unit | `core/post` |

Feed rates follow the same rule: **mm/min** internally.

## 3. Y is up

Internal coordinates are a right-handed system with **+X right, +Y up, +Z up**,
matching the machine. Z=0 is the top of the material by default; cuts go negative.

SVG is Y-down, so the flip happens once during import — not, as in jscut, deferred
all the way to a `-p.Y * scale` in the G-code emitter, which left every
intermediate stage reasoning in a different coordinate system than the output.

## 4. Angles are radians

Internally, always radians, counter-clockwise from +X. Degrees exist only in the
UI and in G-code comments.

## 5. No silent failures

A function that cannot do its job throws or returns an explicit result object. It
does not return an empty array and hope. jscut's habit of silently producing zero
paths when an offset annihilated the geometry is exactly the failure mode that
wastes a workpiece.

## 6. Never compare floats exactly

Not in code, not in tests. `1.5 * 25.4` is `38.099999999999994`, and every
conversion, offset and rotation compounds that. Geometry comparisons go through
an explicit epsilon; tests use `toBeCloseTo`.

The epsilon must be chosen against **machine resolution**, not float precision —
a hobby router resolves somewhere around 0.01mm, so an epsilon of 1e-9 mm is
"exactly equal" for every purpose this program has.
