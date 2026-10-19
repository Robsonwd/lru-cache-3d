# LRU Cache in 3D

An interactive 3D animation that teaches how an LRU (Least Recently Used) cache works. It starts with the idea, then shows the real machinery underneath (a hash map plus a doubly linked list) and why `get` and `put` both run in O(1).

The whole thing ships as one self-contained file, `lru-cache.html`. Double-click it and it runs offline over `file://`, with no network requests.

## Quick start

```sh
npm install      # three (runtime), esbuild (build)
npm run build    # writes lru-cache.html at the project root
npm test         # runs the unit tests with node:test
```

Then open `lru-cache.html` in a desktop browser with WebGL 2 (Chrome, Safari or Firefox). It requires Node 22.

## What you see

- **Slabs** are the cache entries. Each glowing slab shows its key and value. They sit in a row from **HEAD** (most recently used, left) to **TAIL** (least recently used, right).
- **Colour shows recency.** The slab at HEAD is bright white-cyan, and slabs fade toward dim violet as they get closer to TAIL.
- **Light tubes** between neighbours are the `next`/`prev` pointers of the doubly linked list.
- **The bucket wall** behind the row is the hash map. Each bucket sends a beam to its slab, and a lookup fires a pulse along that beam.
- **Ghost outlines** mark unused capacity, so you can see when the cache is full.

| Operation | Animation |
|---|---|
| `get` hit | Pulse to the slab, which unlinks, flies to HEAD and relinks |
| `get` miss | Pulse to an empty bucket, which flashes red |
| `put` new key | A new slab appears at HEAD and its bucket gains a beam |
| `put` existing key | The value text morphs, then the slab moves to HEAD |
| `put` when full | The TAIL slab shatters and its bucket goes dark, then the new slab is inserted |

## Modes

### Guided tour

The tour has six chapters and uses capacity 3, so evictions happen early:

1. **Why cache**: a slow source compared with fast but limited memory
2. **The rule**: evict the least recently used entry
3. **The naive way**: an O(n) scan over timestamps
4. **The machinery**: the hash map finds an entry, the linked list reorders
5. **Step by step**: a hit, a miss, an insert, an update and an eviction, slowed down
6. **Full run**: a longer sequence at speed, ending on a recap card

After the last chapter the page switches to the sandbox.

### Sandbox

Run your own `get(key)` and `put(key, value)` calls. Keys and values can be 1 to 3 characters. Capacity runs from 2 to 8 and defaults to 4. Changing capacity resets the cache. If you submit operations while an animation is still playing, they wait in a queue and play in order. A log and hit/miss/eviction counters track what happened.

### Controls

| Input | Action |
|---|---|
| Space | Play / pause |
| Right / Left arrow | Step forward / back one operation (tour only) |
| Speed buttons | 0.5×, 1×, 2× |
| Mouse drag / scroll | Orbit / zoom the camera |
| Enter in a sandbox field | Key field runs `get`, value field runs `put` |

Stepping back doesn't play the animation in reverse. It restores the snapshot from before that operation.

### Deep links

The URL hash can set the starting state: `#ch=4` starts at chapter 4, `#sandbox` opens the sandbox, and `#speed=2` sets the playback speed (any value above 0 up to 8). You can combine them, for example `lru-cache.html#ch=5&speed=2`.

## Architecture

The source is split into modules, and the build bundles them into one HTML file. The cache model and the scene never talk to each other directly. Instead, `lru.js` emits a list of **steps**, and the animator turns those steps into scene animations.

```
lru.js ──steps──▶ animator.js ──clips──▶ scene/ (Three.js)
                      ▲                      ▲
                 tour.js / ui.js        timeline.js
                      ▲
                   main.js
```

| File | Responsibility |
|---|---|
| `src/lru.js` | The LRU cache: a `Map` plus a doubly linked list with sentinel head/tail nodes. `get`/`put` return their result and a list of steps. Also provides `snapshot()` / `LRUCache.fromSnapshot()`. No rendering code. |
| `src/timeline.js` | Small tween and sequencing library: easing, sequences, parallel groups, pause, speed scaling (`Player`). |
| `src/animator.js` | Turns step lists into timelines of scene primitives. Owns the operation queue, stats, log entries and step-back snapshots. |
| `src/chapters.js` | Tour content as data: captions, operations, camera moves, scans, recap card. |
| `src/tour.js` | Plays the chapters: sequencing, stepping, chapter jumps. |
| `src/ui.js` | HTML overlay: captions, transport controls, chapter nav, sandbox form, log, counters, keyboard handling. |
| `src/validate.js` | Validates sandbox input (key/value length, capacity range). |
| `src/scene/` | Three.js scene: `stage.js` (renderer, camera, bloom, stars), `slabs.js`, `links.js`, `hashmap.js`, `effects.js`, `text.js`, `layout.js`. `index.js` exposes primitives such as `lookup`, `detach`, `attachHead`, `evict` and `syncTo(snapshot)`. |
| `src/main.js` | Entry point. Wires everything together, handles deep links and WebGL failure. |
| `src/index.html`, `src/styles.css` | Page template and styles. |
| `build.mjs` | Bundles `src/main.js` with esbuild (IIFE, minified) and inlines the JS and CSS into `lru-cache.html`. |

### Step vocabulary

These steps are the contract between `lru.js` and the animator:

`lookup {key, found}` · `detach {key}` · `attachHead {key}` · `create {key, value}` · `update {key, oldValue, value}` · `evict {key}` · `mapSet {key}` · `mapDelete {key}` · `result {kind, value?}`, where `kind` is `hit`, `miss`, `inserted` or `updated`.

## Testing

`npm test` runs the `node:test` suites in `test/`:

- `lru.test.js`: hits, misses, inserts, updates, eviction order, capacity 1, snapshot round-trips, and the exact step lists
- `timeline.test.js`: sequencing, pause and speed
- `animator.test.js`, `tour.test.js`, `chapters.test.js`: queueing, stepping and chapter content
- `layout.test.js`, `validate.test.js`: scene layout maths and input validation
- `build.test.js`: the built page inlines everything and references no external scripts or styles

## Debugging

The running page exposes `window.__lru = { scene, player, animator, tour, ui }` for poking at it from the browser console.

## Further reading

- Design spec: `docs/superpowers/specs/2026-10-02-lru-cache-3d-design.md`
- Implementation plan: `docs/superpowers/plans/2026-10-02-lru-cache-3d.md`
