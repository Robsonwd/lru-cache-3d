# LRU Cache in 3D — Design Spec

Date: 2026-10-02
Status: awaiting review

## 1. Purpose

A visually striking 3D animation that teaches one person (the project owner) how an LRU cache works: first the idea, then the real machinery (hash map plus doubly linked list) and why `get` and `put` are O(1).

Success means: after the guided tour, the viewer can explain the eviction rule, name the two data structures and what each one is for, and predict what the cache does for any sequence of `get`/`put` calls. The sandbox lets them test those predictions.

## 2. Constraints

- Delivered as one file, `lru-cache.html`, at the project root. It opens by double-click (`file://`) and works offline: no network requests at runtime.
- Target: desktop Chrome, Safari, and Firefox on macOS. No mobile layout.
- Runtime dependency: Three.js only, bundled into the file. No animation library; a small in-house timeline utility is enough.
- Build tooling: Node 22, esbuild (dev dependency), `node:test` for unit tests.
- No git. Nothing is committed.
- Implementation is carried out by subagents running on Opus 5.5.

## 3. The scene

A dark, deep-space stage with bloom post-processing and a sparse star field.

- **Slabs (cache entries).** Each entry is a glowing crystal slab showing its key and value. Slabs sit in a row from **HEAD** (most recently used, left) to **TAIL** (least recently used, right). HEAD and TAIL are labelled markers at the ends of the row.
- **Recency.** Colour and brightness encode recency: the slab at HEAD is white-cyan and bright; slabs cool toward dim violet as they approach TAIL. Colour is recomputed from position whenever the order changes.
- **Doubly linked list.** Neighbouring slabs are joined by two light tubes (`next` and `prev`) with particles flowing in the direction of each pointer.
- **Hash map.** A wall of key buckets sits behind the row. Each occupied bucket shows its key and holds a beam to its slab. A lookup fires a bright pulse along that beam.
- **Empty capacity.** Unused capacity is shown as faint ghost outlines in the row, so "the cache is full" is visible.

## 4. Operations and their animations

| Operation | Steps shown |
|---|---|
| `get` hit | Pulse from the key's bucket to its slab. The slab lifts out; its neighbours' tubes re-link to each other. The slab flies to HEAD, links in, and flares. Colours along the row re-settle. |
| `get` miss | Pulse travels to an empty bucket, which flashes red. Nothing else moves. |
| `put` new key, space available | A slab materialises at HEAD and links in. A bucket lights up and gains a beam. |
| `put` existing key | Pulse to the slab, the value text morphs to the new value, then the slab moves to HEAD as in a hit. |
| `put` new key, cache full | The TAIL slab shatters into particles, its tubes retract, its bucket goes dark. Then the new slab inserts as above. |

Each operation also appears in the on-screen log with its outcome (hit, miss, inserted, updated, evicted X).

## 5. Guided tour

Six chapters, played in order, each with captions synchronised to the animation. The tour uses capacity 3 so eviction arrives quickly.

1. **Why cache.** A slow source versus fast memory; memory is limited, so something must be thrown away.
2. **The rule.** Evict the least recently used entry. Shown with the recency colours only, before any internals.
3. **The naive way.** Finding the least recently used entry by scanning: a highlight visits every slab and a comparison counter climbs. This is O(n).
4. **The machinery.** The hash map wall and the linked-list tubes fade in. The hash map finds a slab in one hop; the list keeps the order and lets a slab be unlinked and relinked in constant time.
5. **`get` and `put` step by step.** One hit, one miss, one insert, one update, one eviction, each slowed down with a caption per step.
6. **Full run.** A longer sequence at speed with hit/miss counters, ending on a recap card with the O(1) summary.

When chapter 6 ends, the page switches to the sandbox.

## 6. Sandbox

- Inputs: `get(key)` and `put(key, value)`. Keys and values are short strings (1 to 3 characters).
- Capacity control, 2 to 8, default 4. Changing capacity resets the cache.
- Reset button, operation log, hit/miss counters.
- Invalid input (empty key, empty value on `put`) is rejected inline next to the field; nothing animates.
- Operations submitted while an animation is running are queued and played in order.

## 7. Controls

Available in both tour and sandbox unless noted.

- Play/pause (Space).
- Step forward / step back by one operation (Right / Left arrow). Tour only.
- Speed: 0.5x, 1x, 2x.
- Chapter jump (tour) and a Tour/Sandbox switch.
- Mouse drag orbits the camera; scroll zooms. Scripted camera moves in the tour take over when a chapter needs a specific view.

Stepping back does not play animations in reverse. It restores the cache snapshot taken before the operation and snaps the scene to that state.

## 8. Architecture

Source is modular; the build produces one file.

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/lru.js` | The LRU cache itself: hash map plus doubly linked list. No rendering. Each `get`/`put` returns its result and an ordered list of steps describing what happened. Provides `snapshot()` and restore. | nothing |
| `src/timeline.js` | Small tween and sequencing utility: easing, sequences, parallel groups, pause, speed scaling. | nothing |
| `src/scene/` | Three.js stage (camera, lights, bloom, stars), slabs, link tubes, hash-map wall, particle effects. Exposes primitives such as "create slab", "move slab to index", "shatter slab", "pulse bucket", and `syncTo(snapshot)` for instant state changes. | three, timeline |
| `src/animator.js` | Translates a step list from `lru.js` into a timeline of scene primitives. Owns the operation queue, play/pause, speed, and step back. | lru, timeline, scene |
| `src/tour.js` | Chapter scripts as data: captions, operations, camera moves, and chapter-only effects (the naive scan). | animator |
| `src/ui.js` | HTML overlay: captions, transport controls, chapter navigation, sandbox form, log, counters. | animator, tour |
| `src/main.js` | Wires everything together and starts the tour. | all |
| `build.mjs` | Bundles `src/` and Three.js with esbuild and inlines the result into `lru-cache.html`. | esbuild |

### Step vocabulary emitted by `lru.js`

`lookup {key, found}`, `detach {key}`, `attachHead {key}`, `create {key, value}`, `update {key, oldValue, value}`, `evict {key}`, `mapSet {key}`, `mapDelete {key}`, `result {kind, value?}` where `kind` is `hit`, `miss`, `inserted`, or `updated`.

This list is the contract between the cache model and the animator. The scene never reads the cache's internals; it only reacts to steps and snapshots.

## 9. Error handling

- WebGL unavailable: show a plain message explaining that the page needs WebGL, instead of a blank canvas.
- Window resize: the renderer and camera adapt; the overlay stays readable down to 1024 px wide.
- Tab hidden: the render loop pauses and resumes without time jumps.

## 10. Testing and verification

- **Unit tests (`node:test`)** for `src/lru.js`: hit, miss, insert, update, eviction order, capacity 1 edge case, snapshot and restore, and the exact step list for each operation type. Unit tests for `src/timeline.js` sequencing, pause, and speed.
- **Build check:** `node build.mjs` produces `lru-cache.html` containing no external URLs for scripts or styles.
- **Browser verification:** open the built file in Chrome over `file://`, play every chapter, exercise the sandbox (hit, miss, eviction, capacity change, invalid input), screenshot each chapter, and confirm the console has no errors.

## 11. Out of scope

- A code panel highlighting lines of `get`/`put`.
- Sound, narration audio, mobile and touch layouts.
- Other eviction policies (LFU, FIFO, TTL).
- Saving or sharing sandbox sessions.
