# GollyGCode

A local-first SVG → G-code CAM application for hobby CNC routers.
Vue 3 + Electron, with a framework-free CAM core.

Built to replace [jscut](http://jscut.org) with the things it was missing:
the full SVG primitive set, open-path toolpaths, tabs that actually work,
spindle control, arc output, and corner relief.

## Status

Early. See [`plan.md`](./plan.md) for the phased build plan and what's done.

## Requirements

- Node 22+
- npm 10+

## Setup

`vue-win-mgr` is consumed as a local `file:` dependency while we iterate on it,
so it has to be built first:

```sh
cd ../Vue-Window-Manager
npm ci          # NOT `npm install` -- see below
npm run build

cd ../gollygcode
npm install
```

> **Use `npm ci` in `Vue-Window-Manager`, not `npm install`.** A fresh resolution
> pulls a `vite-plugin-dts` / `@volar/typescript` / `typescript` combination that
> fails at config load with
> `TypeError: Cannot read properties of undefined (reading 'useCaseSensitiveFileNames')`.
> The committed lockfile pins a working set (typescript 5.8.3, vite-plugin-dts
> 4.5.4, @volar/typescript 2.4.15); `npm ci` honours it, `npm install` does not.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server + Electron, with HMR in the renderer and auto-restart on main-process changes |
| `npm run build` | Build the renderer, then package with electron-builder |
| `npm run build:win` | Windows (nsis, x64) |
| `npm test` | Run the CAM core test suite headlessly |
| `npm run test:watch` | Same, in watch mode |
| `npm run lab` | Visual geometry harness on :8081 — see below |
| `npm run lint` | ESLint over the whole project |

## Layout

```
src/
├─ core/        CAM core. No Vue, no DOM. Runs in Node and in a Web Worker.
├─ main/        Electron main + preload. Plain CommonJS, no compile step.
└─ renderer/    The Vue application.
lab/            Standalone visual geometry prototypes (npm run lab).
tests/          Cross-cutting tests. Unit tests live beside their source.
```

`src/core/` is fenced by lint rules — it cannot import Vue or touch the DOM.
That is what keeps it testable headlessly and runnable off the main thread.
Read [`src/core/CONVENTIONS.md`](./src/core/CONVENTIONS.md) before working in it.

## The lab

Geometry bugs are much easier to see than to read about. `npm run lab` serves
plain pages that import from `src/core` and render their output as inline SVG —
used for offset debugging, self-intersection cleanup, and arc fitting. Nothing
in `lab/` ships.

## Notes for the packaged build

Two things in `src/main/main.cjs` exist to prevent failures that reproduce *only*
after packaging, never under `npm run dev`:

- The renderer is served over a registered `app://` scheme rather than `file://`,
  because a `file://` page has an opaque origin where module workers refuse to
  load and `fetch()` cannot read local files (which breaks wasm instantiation).
- The CSP explicitly permits `blob:` workers and `'wasm-unsafe-eval'`.

If you tighten either one, test a packaged build, not just dev.
