import { LRUCache } from './lru.js';
import { seq, call, wait, rate } from './timeline.js';

const ZERO_STATS = { hits: 0, misses: 0, evictions: 0 };

export function formatCall(op) {
  return op.type === 'get' ? `get(${op.key})` : `put(${op.key}, ${op.value})`;
}

export function describeStep(step) {
  switch (step.type) {
    case 'lookup':
      return step.found
        ? `Hash map: ${step.key} found in one hop.`
        : `Hash map: no entry for ${step.key}.`;
    case 'detach':
      return `Unlink ${step.key}: its two neighbours now point at each other.`;
    case 'attachHead':
      return `Link ${step.key} in at HEAD. It is now the most recently used.`;
    case 'create':
      return `Create an entry for ${step.key} = ${step.value}.`;
    case 'update':
      return `Overwrite the value: ${step.oldValue} becomes ${step.value}.`;
    case 'evict':
      return `The cache is full. Evict ${step.key}, the least recently used, from TAIL.`;
    case 'mapSet':
      return `Add ${step.key} to the hash map, pointing at its entry.`;
    case 'mapDelete':
      return `Remove ${step.key} from the hash map.`;
    case 'result':
      if (step.kind === 'hit') return `Hit: return ${step.value}. Every step was O(1).`;
      if (step.kind === 'miss') return 'Miss: there is nothing to return.';
      if (step.kind === 'updated') return 'Updated. Every step was O(1).';
      return 'Inserted. Every step was O(1).';
    default:
      throw new Error(`unknown step type: ${step.type}`);
  }
}

export function summarize(op, steps) {
  const result = steps.find((step) => step.type === 'result');
  const evicted = steps.find((step) => step.type === 'evict')?.key ?? null;
  let outcome;
  if (result.kind === 'hit') outcome = `hit: ${result.value}`;
  else if (result.kind === 'inserted' && evicted !== null) outcome = `inserted, evicted ${evicted}`;
  else outcome = result.kind;
  return { call: formatCall(op), kind: result.kind, outcome, evicted };
}

function sceneClip(step, op, scene) {
  switch (step.type) {
    case 'lookup': return scene.lookup(step.key, step.found);
    case 'detach': return scene.detach(step.key);
    case 'attachHead': return scene.attachHead(step.key);
    case 'create': return scene.create(step.key, step.value);
    case 'update': return scene.update(step.key, step.value);
    case 'evict': return scene.evict(step.key);
    case 'mapSet': return scene.mapSet(step.key);
    case 'mapDelete': return scene.mapDelete(step.key);
    case 'result': return scene.result(step.kind, op.key);
    default: throw new Error(`unknown step type: ${step.type}`);
  }
}

export function stepsToClip(op, steps, scene, { stepGap = 0, stepLead = 0, onStep, rate: factor = 1 } = {}) {
  const clips = [];
  steps.forEach((step, index) => {
    // The gap goes between steps only: a gap after the last step would hold
    // back the log and the counters after the result is already on screen.
    if (stepGap > 0 && index > 0) clips.push(wait(stepGap));
    if (onStep) clips.push(call(() => onStep(step, index)));
    // The lead sits between a step's onStep and its motion, so a caption set
    // in onStep is readable before the step it describes starts to move.
    if (stepLead > 0) clips.push(wait(stepLead));
    clips.push(sceneClip(step, op, scene));
  });
  const clip = seq(...clips);
  return factor === 1 ? clip : rate(clip, factor);
}

export function createAnimator({ scene, player, capacity = 4, onLog = () => {}, onStats = () => {} }) {
  let cache = new LRUCache(capacity);
  let stats = { ...ZERO_STATS };
  let queue = Promise.resolve();
  // Bumped by restore(); an op from an older generation is abandoned.
  let generation = 0;

  scene.syncTo(cache.snapshot());

  function enqueue(op, opts = {}) {
    const born = generation;
    const job = queue.then(async () => {
      if (born !== generation) return { completed: false };
      const { steps } = op.type === 'get' ? cache.get(op.key) : cache.put(op.key, op.value);
      const summary = summarize(op, steps);
      await player.play(stepsToClip(op, steps, scene, opts));
      if (born !== generation) return { completed: false, steps, summary };
      if (summary.kind === 'hit') stats.hits++;
      if (summary.kind === 'miss') stats.misses++;
      if (summary.evicted !== null) stats.evictions++;
      onLog(summary);
      onStats({ ...stats });
      return { completed: true, steps, summary };
    });
    queue = job.catch(() => {});
    return job;
  }

  function state() {
    return { snapshot: cache.snapshot(), stats: { ...stats } };
  }

  function restore(next) {
    // Build first: a bad snapshot throws here, before anything is cancelled.
    const restored = LRUCache.fromSnapshot(next.snapshot);
    generation++;
    player.cancelAll();
    cache = restored;
    stats = { ...next.stats };
    scene.syncTo(cache.snapshot());
    onStats({ ...stats });
  }

  function reset(nextCapacity) {
    restore({ snapshot: { capacity: nextCapacity, entries: [] }, stats: ZERO_STATS });
  }

  return { enqueue, state, restore, reset };
}
