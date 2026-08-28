# The lab

Standalone scripts that render what the core modules actually produce. They are
not tests and not part of the app; they exist because of a pattern that held
through the whole of Phase 1:

> Every real bug was found by looking at ground truth. None were found by a
> passing test count.

The list, in the order the bugs turned up:

| bug | found by |
|---|---|
| An offset that cut straight **through** the line, 0.0000mm from a requested 1.5875mm | sampling along segments rather than at vertices |
| One side of an open path coming out as **nine pieces** instead of one | Greg looking at a rendered picture |
| A hand-placed tab sliding **6mm** along the path | testing across offset modes, not just cutter sizes |
| Two tabs reported as useless that actually hold **23mm** of material | Greg not believing the warning |
| An arc bulging **5.15mm** off a right-angled corner | reading the emitted G-code back and tracing it |

Assertion counts caught none of those. Every one of them passed the tests that
existed at the time.

## The pages

Each takes an SVG (or a `.nc`) and writes a self-contained HTML file. Nothing
here imports anything from `src/renderer`.

- **`open-offset.mjs`** — the three open-path operations against a drawing, with
  the tool's swept area, so an offset that has gone somewhere wrong is visible.
- **`kerf.mjs`** — the material actually **removed**, filled, at four bit sizes
  and in all four modes. The right picture for judging whether a drawing's
  detail survives a given cutter, because the tool is not a pen.
- **`tabs.mjs`** — the same tabs at four cutter diameters, with a side elevation
  under each plan view. A plan view cannot show a tab.
- **`link.mjs`** — the moves **between** cuts, which a toolpath drawing normally
  omits. Built to compare cut orderings; what it showed instead was that there
  was nothing to order, which is how the nine-pieces bug surfaced.
- **`gcode.mjs`** — the whole pipeline, SVG in and `.nc` out. **Ends by reading
  its own output back**, interpolating the arcs the way a controller would, and
  measuring the traced motion against the toolpath it meant to cut. This is the
  check that caught the 5.15mm arc.
- **`simulate.mjs`** — draws a `.nc` file knowing nothing about how it was made.
  Arcs are coloured separately on purpose, so one that has gone somewhere it
  should not appears as a violet bulge rather than hiding among green lines.
- **`make-serpentine.mjs`** — generates a chirped wave for testing curvature
  from gentle to far tighter than the tool.

## Running them

```
node lab/kerf.mjs misc/painted_ladies_v001.svg lab-output/kerf.html
DPI=72 node lab/gcode.mjs misc/painted_ladies_v001.svg lab-output/out.nc
node lab/simulate.mjs lab-output/out.nc lab-output/simulate.html
```

`DPI` sets the pixels-per-inch assumed for a document whose size is unitless —
Illustrator exports generally want 72. Output goes to `lab-output/`, which is
gitignored. `gcode.mjs` also takes `ARCTOL`, `DEC`, `TABS=1` and `NORAMP=1`.

## Keeping them alive

These stay maintained as the core changes. A lab page that no longer runs is a
check that has silently stopped happening, and the table above is what that
costs.
