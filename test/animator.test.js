import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player, call } from '../src/timeline.js';
import { createAnimator, describeStep, summarize, formatCall, stepsToClip } from '../src/animator.js';

function fakeScene() {
  const calls = [];
  const clip = (name) => (...args) => call(() => calls.push([name, ...args]));
  return {
    calls,
    syncTo: (snapshot) => calls.push(['syncTo', structuredClone(snapshot)]),
    lookup: clip('lookup'),
    detach: clip('detach'),
    attachHead: clip('attachHead'),
    create: clip('create'),
    update: clip('update'),
    evict: clip('evict'),
    mapSet: clip('mapSet'),
    mapDelete: clip('mapDelete'),
    result: clip('result'),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function drain(player, turns = 60) {
  for (let i = 0; i < turns; i++) {
    await tick();
    player.update(1);
  }
}

function setup(capacity = 2) {
  const scene = fakeScene();
  const player = new Player();
  const logs = [];
  const statsSeen = [];
  const animator = createAnimator({
    scene, player, capacity,
    onLog: (entry) => logs.push(entry),
    onStats: (stats) => statsSeen.push(stats),
  });
  return { scene, player, logs, statsSeen, animator };
}

const put = (key, value) => ({ type: 'put', key, value });
const get = (key) => ({ type: 'get', key });

test('syncs the scene to an empty cache on creation', () => {
  const { scene } = setup(3);
  assert.deepEqual(scene.calls, [['syncTo', { capacity: 3, entries: [] }]]);
});

test('a put plays one scene clip per step, in step order', async () => {
  const { scene, player, logs, animator } = setup();
  const pending = animator.enqueue(put('A', '1'));
  await drain(player);
  const result = await pending;
  assert.equal(result.completed, true);
  assert.deepEqual(scene.calls.slice(1), [
    ['lookup', 'A', false],
    ['create', 'A', '1'],
    ['attachHead', 'A'],
    ['mapSet', 'A'],
    ['result', 'inserted', 'A'],
  ]);
  assert.deepEqual(logs, [{ call: 'put(A, 1)', kind: 'inserted', outcome: 'inserted', evicted: null }]);
});

test('ops enqueued together play in submission order', async () => {
  const { scene, player, logs, animator } = setup(2);
  for (const op of [put('A', '1'), put('B', '2'), get('A'), put('C', '3'), get('B'), get('C')]) {
    animator.enqueue(op);
  }
  await drain(player);
  assert.deepEqual(logs.map((l) => l.call),
    ['put(A, 1)', 'put(B, 2)', 'get(A)', 'put(C, 3)', 'get(B)', 'get(C)']);
  assert.deepEqual(logs.map((l) => l.outcome),
    ['inserted', 'inserted', 'hit: 1', 'inserted, evicted B', 'miss', 'hit: 3']);
  assert.deepEqual(animator.state(), {
    snapshot: { capacity: 2, entries: [{ key: 'C', value: '3' }, { key: 'A', value: '1' }] },
    stats: { hits: 2, misses: 1, evictions: 1 },
  });
  assert.deepEqual(scene.calls.slice(1), [
    // put(A, 1)
    ['lookup', 'A', false], ['create', 'A', '1'], ['attachHead', 'A'], ['mapSet', 'A'], ['result', 'inserted', 'A'],
    // put(B, 2)
    ['lookup', 'B', false], ['create', 'B', '2'], ['attachHead', 'B'], ['mapSet', 'B'], ['result', 'inserted', 'B'],
    // get(A): A is behind B, so it moves to HEAD
    ['lookup', 'A', true], ['detach', 'A'], ['attachHead', 'A'], ['result', 'hit', 'A'],
    // put(C, 3): full, B is at TAIL and is evicted
    ['lookup', 'C', false], ['evict', 'B'], ['mapDelete', 'B'],
    ['create', 'C', '3'], ['attachHead', 'C'], ['mapSet', 'C'], ['result', 'inserted', 'C'],
    // get(B): miss
    ['lookup', 'B', false], ['result', 'miss', 'B'],
    // get(C): already at HEAD
    ['lookup', 'C', true], ['result', 'hit', 'C'],
  ]);
});

test('get of the head key plays lookup and result only', async () => {
  const { scene, player, logs, animator } = setup();
  animator.enqueue(put('A', '1'));
  await drain(player);
  scene.calls.length = 0;
  animator.enqueue(get('A'));
  await drain(player);
  assert.deepEqual(scene.calls, [['lookup', 'A', true], ['result', 'hit', 'A']]);
  assert.deepEqual(logs.at(-1), { call: 'get(A)', kind: 'hit', outcome: 'hit: 1', evicted: null });
  assert.deepEqual(animator.state().stats, { hits: 1, misses: 0, evictions: 0 });
});

test('put to the head key plays lookup, update and result only', async () => {
  const { scene, player, logs, animator } = setup();
  animator.enqueue(put('A', '1'));
  await drain(player);
  scene.calls.length = 0;
  animator.enqueue(put('A', '2'));
  await drain(player);
  assert.deepEqual(scene.calls, [['lookup', 'A', true], ['update', 'A', '2'], ['result', 'updated', 'A']]);
  assert.deepEqual(logs.at(-1), { call: 'put(A, 2)', kind: 'updated', outcome: 'updated', evicted: null });
  assert.deepEqual(animator.state().snapshot, { capacity: 2, entries: [{ key: 'A', value: '2' }] });
});

test('onStep sees every step in order, and stepGap spaces them out', async () => {
  const { player, animator } = setup();
  const seen = [];
  const pending = animator.enqueue(put('A', '1'), { stepGap: 1, onStep: (step, i) => seen.push([i, step.type]) });
  await tick();
  player.update(0.5);
  assert.deepEqual(seen, [[0, 'lookup']]);
  await drain(player);
  assert.deepEqual(seen, [[0, 'lookup'], [1, 'create'], [2, 'attachHead'], [3, 'mapSet'], [4, 'result']]);
  assert.equal((await pending).completed, true);
});

test('stepGap goes between steps, not after the last one', () => {
  const scene = fakeScene();
  const steps = [
    { type: 'lookup', key: 'A', found: false },
    { type: 'create', key: 'A', value: '1' },
    { type: 'attachHead', key: 'A' },
    { type: 'mapSet', key: 'A' },
    { type: 'result', kind: 'inserted' },
  ];
  // The fake clips take no time, so the whole clip is the gaps alone.
  assert.equal(stepsToClip(put('A', '1'), steps, scene, { stepGap: 1 }).duration, 4);
  assert.equal(stepsToClip(put('A', '1'), steps, scene, { stepGap: 1, rate: 2 }).duration, 2);
  assert.equal(stepsToClip(put('A', '1'), steps, scene).duration, 0);
});

test('stepLead holds each step back after its onStep, without changing the order', async () => {
  const { scene, player, animator } = setup();
  const events = [];
  const sceneCalls = () => scene.calls.slice(1).map(([name]) => name);
  const pending = animator.enqueue(put('A', '1'), {
    stepLead: 1, stepGap: 1, onStep: (step) => events.push(['onStep', step.type]),
  });
  await tick();
  // t = 0: the first onStep has fired, its scene clip waits behind the lead.
  player.update(0);
  assert.deepEqual(events, [['onStep', 'lookup']]);
  assert.deepEqual(sceneCalls(), []);
  player.update(1);
  assert.deepEqual(sceneCalls(), ['lookup']);
  // Gap, then the next onStep, then its lead.
  player.update(1);
  assert.deepEqual(events.at(-1), ['onStep', 'create']);
  assert.deepEqual(sceneCalls(), ['lookup']);
  player.update(1);
  assert.deepEqual(sceneCalls(), ['lookup', 'create']);
  await drain(player);
  assert.equal((await pending).completed, true);
  assert.deepEqual(events.map(([, type]) => type), ['lookup', 'create', 'attachHead', 'mapSet', 'result']);
  assert.deepEqual(sceneCalls(), ['lookup', 'create', 'attachHead', 'mapSet', 'result']);
});

test('stepLead adds one lead per step to the clip', () => {
  const scene = fakeScene();
  const steps = [
    { type: 'lookup', key: 'A', found: false },
    { type: 'create', key: 'A', value: '1' },
    { type: 'result', kind: 'inserted' },
  ];
  const onStep = () => {};
  assert.equal(stepsToClip(put('A', '1'), steps, scene, { stepLead: 1, stepGap: 1, onStep }).duration, 5);
  assert.equal(stepsToClip(put('A', '1'), steps, scene, { stepGap: 1, onStep }).duration, 2);
});

test('a slow op logs and counts as soon as its result step has played', async () => {
  const { scene, player, logs, statsSeen, animator } = setup();
  const pending = animator.enqueue(get('Q'), { stepGap: 1 });
  await tick();
  // get(Q) is lookup, gap, result: the result plays at t = 1.
  player.update(1);
  assert.deepEqual(scene.calls.at(-1), ['result', 'miss', 'Q']);
  await tick();
  await tick();
  assert.equal(logs.length, 1, 'no trailing gap holds the log back');
  player.update(1);
  assert.equal((await pending).completed, true);
  assert.deepEqual(statsSeen.at(-1), { hits: 0, misses: 1, evictions: 0 });
});

test('restore with a bad snapshot throws and leaves the animator untouched', async () => {
  const { scene, player, logs, animator } = setup();
  const pending = animator.enqueue(put('A', '1'), { stepGap: 1 });
  await tick();
  player.update(0.5);
  const before = animator.state();
  const syncs = scene.calls.filter(([name]) => name === 'syncTo').length;
  const bad = { snapshot: { capacity: 1, entries: [{ key: 'X', value: '1' }, { key: 'Y', value: '2' }] }, stats: before.stats };
  assert.throws(() => animator.restore(bad), RangeError);
  assert.equal(player.busy, true, 'the op in flight was not cancelled');
  assert.equal(scene.calls.filter(([name]) => name === 'syncTo').length, syncs, 'the scene was not touched');
  await drain(player);
  assert.equal((await pending).completed, true, 'the op in flight still completes');
  assert.equal(logs.length, 1);
  assert.deepEqual(animator.state().snapshot, { capacity: 2, entries: [{ key: 'A', value: '1' }] });
});

test('restore mid-flight drops in-flight and queued ops', async () => {
  const { scene, player, logs, animator } = setup();
  const first = animator.enqueue(put('A', '1'), { stepGap: 1 });
  const second = animator.enqueue(put('B', '2'));
  await tick();
  player.update(0.5);
  const state = {
    snapshot: { capacity: 2, entries: [{ key: 'Q', value: '7' }] },
    stats: { hits: 5, misses: 0, evictions: 0 },
  };
  animator.restore(state);
  await drain(player);
  assert.equal((await first).completed, false);
  assert.equal((await second).completed, false);
  assert.deepEqual(logs, []);
  assert.deepEqual(animator.state(), state);
  assert.deepEqual(scene.calls.at(-1), ['syncTo', state.snapshot]);
});

test('ops enqueued after a restore run normally', async () => {
  const { player, logs, animator } = setup();
  animator.enqueue(put('A', '1'), { stepGap: 1 });
  await tick();
  animator.reset(3);
  animator.enqueue(put('B', '2'));
  await drain(player);
  assert.deepEqual(logs.map((l) => l.call), ['put(B, 2)']);
  assert.deepEqual(animator.state().snapshot, { capacity: 3, entries: [{ key: 'B', value: '2' }] });
});

test('reset reports zero stats', async () => {
  const { player, statsSeen, animator } = setup();
  animator.enqueue(get('A'));
  await drain(player);
  animator.reset(4);
  assert.deepEqual(statsSeen.at(-1), { hits: 0, misses: 0, evictions: 0 });
  assert.deepEqual(animator.state().snapshot, { capacity: 4, entries: [] });
});

test('formatCall and summarize describe each outcome', () => {
  assert.equal(formatCall(get('A')), 'get(A)');
  assert.equal(formatCall(put('A', '1')), 'put(A, 1)');
  assert.deepEqual(
    summarize(put('A', '9'), [{ type: 'lookup', key: 'A', found: true }, { type: 'result', kind: 'updated', value: '9' }]),
    { call: 'put(A, 9)', kind: 'updated', outcome: 'updated', evicted: null },
  );
});

test('describeStep has a sentence for every step type', () => {
  const steps = [
    { type: 'lookup', key: 'A', found: true },
    { type: 'lookup', key: 'A', found: false },
    { type: 'detach', key: 'A' },
    { type: 'attachHead', key: 'A' },
    { type: 'create', key: 'A', value: '1' },
    { type: 'update', key: 'A', oldValue: '1', value: '2' },
    { type: 'evict', key: 'A' },
    { type: 'mapSet', key: 'A' },
    { type: 'mapDelete', key: 'A' },
    { type: 'result', kind: 'hit', value: '1' },
    { type: 'result', kind: 'miss' },
    { type: 'result', kind: 'inserted' },
    { type: 'result', kind: 'updated', value: '2' },
  ];
  const sentences = steps.map(describeStep);
  for (const sentence of sentences) assert.ok(sentence.length > 10 && sentence.length <= 150);
  assert.equal(new Set(sentences).size, sentences.length, 'each is distinct');
  assert.throws(() => describeStep({ type: 'nope' }));
});
