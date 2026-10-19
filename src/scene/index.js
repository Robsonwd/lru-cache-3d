import { seq, wait, tween, ease } from '../timeline.js';
import { createStage } from './stage.js';
import { createSlabs } from './slabs.js';
import { createLinks } from './links.js';
import { createHashMap } from './hashmap.js';
import { viewFor } from './layout.js';

export function createScene(canvas) {
  const stage = createStage(canvas);
  const slabs = createSlabs(stage);
  const links = createLinks(stage, slabs);
  const hashmap = createHashMap(stage, slabs);
  let internalsAlpha = 0;

  function setInternals(alpha) {
    internalsAlpha = alpha;
    links.setAlpha(alpha);
    hashmap.setAlpha(alpha);
  }
  setInternals(0);

  return {
    start: (tick) => stage.start(tick),
    syncTo(snapshot) {
      slabs.syncTo(snapshot);
      hashmap.syncTo(snapshot);
      links.syncTo();
    },
    setInternals,
    setView(name) { stage.setView(viewFor(name, slabs.capacity())); },
    cameraTo: (name, duration) => stage.cameraClip(() => viewFor(name, slabs.capacity()), duration),
    fadeInternals(alpha, duration) {
      let from = 0;
      let drawOn = false;
      return tween({
        duration,
        ease: ease.linear,
        onStart() {
          from = internalsAlpha;
          // Revealed from nothing: draw the machinery on, cell by cell and
          // pointer by pointer, instead of a plain fade.
          drawOn = from < 0.01 && alpha > 0.99;
        },
        onUpdate(p) {
          setInternals(from + (alpha - from) * ease.inOutCubic(drawOn ? Math.min(p / 0.45, 1) : p));
          if (drawOn) {
            hashmap.reveal(p);
            links.reveal(p);
          }
        },
        onComplete() {
          if (!drawOn) return;
          hashmap.reveal(null);
          links.reveal(null);
        },
      });
    },
    lookup: (key, found) => seq(hashmap.lookup(key, found), found ? slabs.glint(key) : wait(0.2)),
    detach: (key) => slabs.detach(key),
    attachHead: (key) => slabs.attachHead(key),
    create: (key, value) => slabs.create(key, value),
    update: (key, value) => slabs.update(key, value),
    evict: (key) => slabs.evict(key),
    mapSet: (key) => hashmap.mapSet(key),
    mapDelete: (key) => hashmap.mapDelete(key),
    result: (kind, key) => slabs.result(kind, key),
    scan: (opts) => slabs.scan(opts),
  };
}
