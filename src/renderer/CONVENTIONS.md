# `src/renderer` conventions

Rules that hold everywhere below this directory. `src/core/CONVENTIONS.md` covers
the CAM core; this covers the application layer.

## 1. Shallow reactivity only

**`shallowRef` and `shallowReactive`. Never `ref` on an object, never
`reactive`.**

Vue's deep reactivity wraps every nested object on first access, and the proxies
that result leak into everything that is not Vue:

- `structuredClone` throws `DataCloneError` on a proxy. Measured, not assumed —
  it is why `core/project/snapshot.js` walks by hand.
- Object identity stops being stable. `state.nodes.a` is a different object each
  time it is reached by a different path, so `===`, `Map` keys and `WeakMap`
  caches all quietly stop meaning what they say.
- Any library handed a proxied object stores the proxy. Three.js keeping a
  proxied `Float32Array`, or Clipper keeping a proxied point list, is a cost
  paid on every read for a reactivity nobody wanted.
- The cost is per property access, and this application's hot data is toolpaths
  with tens of thousands of points. A deep proxy over that is not a tax, it is a
  different program.

Shallow means reactivity triggers on **replacement**, not mutation. That is the
trade: you have to say when something changed, rather than being told. For a
document with an undo stack that is not a cost, because we are already saying —
see the next rule.

Where a container really does need in-place scalar writes from outside our own
code, `shallowReactive` is the answer, not `reactive`. It is a one-level proxy:
scalar writes trigger, and nothing nested is ever wrapped. `settings` in App.vue
is the case — `vue-settings-panel` writes into it with `settings[key] = value`
and checks `isReactive` first, which `shallowReactive` satisfies.

## 2. The store says what changed; the proxy does not

Every command already declares `touches` — the node subtrees it will change (see
`core/project/history.js`). That one list does three jobs:

1. what to snapshot for undo,
2. which jobs' G-code is stale (Phase 5.2),
3. **which `shallowRef`s to replace**, which is this file's rule.

So per-node reactivity is exact and fine-grained without a single deep proxy: on
commit the store replaces the ref for every node in the changed set, and views
watching other nodes do not re-run.

The failure mode is a stale view with no error — the same shape as an
under-declared `touches`, and caught by the same thing: `verify` mode does the
undo round trip on every dispatch and throws when a command changed something it
did not name.

## 3. Nothing outside the store may mutate the document

Components dispatch commands. They do not write to project state, not even a
field they "own". This is what makes undo complete rather than mostly complete,
and it is the reason 3.1 was built before anything existed to mutate.

Application settings and per-window view state are not the document and do not
go through commands. The line is the one drawn in `settings/spec.js`: anything
that changes the G-code belongs to the project.
