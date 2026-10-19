import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player, call, seq, wait } from '../src/timeline.js';
import { createAnimator } from '../src/animator.js';
import { createTour } from '../src/tour.js';
import { chapters } from '../src/chapters.js';

// opDuration and scanDuration give operation clips and the scan real length, so a
// test can interrupt them mid-animation. At 0 every clip finishes at once.
function fakeScene({ opDuration = 0, scanDuration = 0 } = {}) {
  const instant = () => call(() => {});
  const clip = opDuration > 0 ? () => wait(opDuration) : instant;
  return {
    views: [],
    internals: [],
    syncTo() {},
    setInternals(alpha) { this.internals.push(alpha); },
    setView(name) { this.views.push(name); },
    lookup: clip, detach: clip, attachHead: clip, create: clip, update: clip, evict: clip,
    mapSet: clip, mapDelete: clip, result: clip, cameraTo: instant, fadeInternals: instant,
    scan: ({ onVisit }) => (scanDuration > 0
      ? seq(call(() => onVisit(1)), wait(scanDuration), call(() => onVisit(3)))
      : call(() => onVisit(3))),
  };
}

function fakeUI() {
  const ui = { chapters: [], captions: [], logCount: 0, playing: null, card: null, counter: null, op: null };
  return Object.assign(ui, {
    setCaption: (text) => ui.captions.push(text),
    setOp: (text) => { ui.op = text ?? null; },
    setChapter: (index) => ui.chapters.push(index),
    setPlaying: (value) => { ui.playing = value; },
    clearLog: () => { ui.logCount = 0; },
    truncateLog: (count) => { ui.logCount = count; },
    showCard: (card) => { ui.card = card; },
    setCounter: (label, n) => {
      ui.counter = label === null ? null : n;
      if (label !== null) ui.counterLabel = label;
    },
  });
}

function setup(sceneOptions) {
  const scene = fakeScene(sceneOptions);
  const ui = fakeUI();
  const player = new Player();
  const animator = createAnimator({ scene, player, capacity: 3, onLog: () => { ui.logCount++; } });
  let ended = false;
  const tour = createTour({ chapters, animator, scene, player, ui, onEnd: () => { ended = true; } });
  return { tour, ui, scene, player, animator, ended: () => ended };
}

async function pump(player, until, limit = 5000) {
  for (let i = 0; i < limit; i++) {
    if (until()) return;
    await new Promise((resolve) => setImmediate(resolve));
    player.update(0.5);
  }
  assert.fail('pump limit reached');
}

async function idle(player, turns) {
  for (let i = 0; i < turns; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    player.update(0.5);
  }
}

const keysOf = (animator) => animator.state().snapshot.entries.map((e) => e.key);

test('plays every chapter in order, then calls onEnd', async () => {
  const { tour, ui, player, ended } = setup();
  tour.start(0);
  await pump(player, ended);
  assert.deepEqual(ui.chapters, [0, 1, 2, 3, 4, 5]);
  assert.equal(ui.card, null, 'the recap card is taken down');
  assert.equal(ui.counter, null, 'the scan counter does not leak into later chapters');
});

test('chapter 5 captions each step of a slow operation', async () => {
  const { tour, ui, player } = setup();
  tour.start(4);
  await pump(player, () => tour.position().chapter === 5);
  assert.ok(ui.captions.includes('Hash map: C found in one hop.'));
  assert.ok(ui.captions.includes('The cache is full. Evict E, the least recently used, from TAIL.'));
});

test('a slow operation shows each step caption before that step starts to move', async () => {
  const { tour, ui, scene, player } = setup();
  let clock = 0;
  let captionAt = null;
  let lookupAt = null;
  const setCaption = ui.setCaption;
  ui.setCaption = (text) => {
    if (text === 'Hash map: C found in one hop.' && captionAt === null) captionAt = clock;
    setCaption(text);
  };
  scene.lookup = () => call(() => { if (lookupAt === null) lookupAt = clock; });
  tour.start(4);
  while (lookupAt === null && clock < 20) {
    await new Promise((resolve) => setImmediate(resolve));
    player.update(0.05);
    clock += 0.05;
  }
  assert.ok(captionAt !== null && lookupAt !== null);
  const lead = lookupAt - captionAt;
  assert.ok(lead >= 0.35 && lead <= 0.45, `the motion starts ${lead.toFixed(2)} s after its caption`);
});

test('a slow operation holds its result caption before the next operation starts', async () => {
  const { tour, ui, player } = setup();
  tour.start(4);
  const hit = 'Hit: return 3. Every step was O(1).';
  await pump(player, () => ui.captions.includes(hit));
  let held = 0;
  while (ui.captions.at(-1) === hit && held < 10) {
    await new Promise((resolve) => setImmediate(resolve));
    player.update(0.05);
    held += 0.05;
  }
  assert.equal(ui.captions.at(-1), 'Hash map: no entry for X.');
  assert.ok(held >= 1.45, `the result caption held for ${held.toFixed(2)} s`);
});

test('a chapter that opens by revealing the internals waits for its title to clear', async () => {
  const { tour, scene, player } = setup();
  let clock = 0;
  let fadedAt = null;
  scene.fadeInternals = () => call(() => { fadedAt = clock; });
  tour.start(3);
  while (fadedAt === null && clock < 10) {
    await new Promise((resolve) => setImmediate(resolve));
    player.update(0.05);
    clock += 0.05;
  }
  assert.ok(fadedAt !== null, 'the internals fade in');
  assert.ok(fadedAt >= 1.35, `the fade starts at ${fadedAt.toFixed(2)} s, under the title`);
  assert.deepEqual(tour.position(), { chapter: 3, beat: 0 }, 'within the same beat');
});

test('stepBack undoes the operation that has started, and pauses ready to replay it', async () => {
  const { tour, ui, player, animator } = setup();
  tour.start(1);
  // Chapter 2 beats: 0 caption, 1 caption, 2 get(B), 3 put(D), 4 get(C), 5 put(E), 6 caption.
  // Initial C A B; after get(B): B C A; after put(D): D B C; after get(C): C D B.
  await pump(player, () => tour.position().beat === 4);
  tour.stepBack();
  assert.deepEqual(tour.position(), { chapter: 1, beat: 4 });
  assert.equal(tour.isPlaying(), false);
  assert.equal(ui.playing, false);
  assert.deepEqual(keysOf(animator), ['D', 'B', 'C']);
  assert.equal(ui.logCount, 2);
  await idle(player, 30);
  assert.deepEqual(tour.position(), { chapter: 1, beat: 4 }, 'paused means paused');
  assert.deepEqual(keysOf(animator), ['D', 'B', 'C'], 'the model does not run ahead while paused');
  assert.equal(ui.logCount, 2, 'the undone operation does not log again');
});

test('stepForward plays exactly one operation, then pauses', async () => {
  const { tour, ui, player, animator } = setup();
  tour.start(1);
  await pump(player, () => tour.position().beat === 4);
  tour.stepBack();
  tour.stepForward();
  assert.equal(tour.isPlaying(), true);
  await pump(player, () => !tour.isPlaying());
  assert.deepEqual(keysOf(animator), ['C', 'D', 'B']);
  assert.equal(ui.logCount, 3);
  await idle(player, 30);
  assert.equal(ui.logCount, 3);
});

test('repeated stepBack while paused walks back one operation per press', async () => {
  const { tour, ui, player, animator } = setup();
  tour.start(1);
  await pump(player, () => tour.position().beat === 4);
  tour.stepBack();
  tour.stepForward();
  await pump(player, () => !tour.isPlaying());
  // get(C) replayed; the run now waits at the gate of beat 5, which has not started.
  assert.deepEqual(tour.position(), { chapter: 1, beat: 5 });
  tour.stepBack();
  assert.deepEqual(tour.position(), { chapter: 1, beat: 4 });
  assert.deepEqual(keysOf(animator), ['D', 'B', 'C']);
  assert.equal(ui.logCount, 2);
  tour.stepBack();
  assert.deepEqual(tour.position(), { chapter: 1, beat: 3 });
  assert.deepEqual(keysOf(animator), ['B', 'C', 'A']);
  assert.equal(ui.logCount, 1);
  assert.equal(tour.isPlaying(), false);
});

test('stepBack during an animating operation undoes only that operation', async () => {
  const { tour, ui, player, animator } = setup({ opDuration: 1 });
  tour.start(1);
  await pump(player, () => tour.position().beat === 2 && player.busy);
  assert.deepEqual(keysOf(animator), ['B', 'C', 'A'], 'the model has already run get(B)');
  tour.stepBack();
  assert.deepEqual(tour.position(), { chapter: 1, beat: 2 });
  assert.equal(tour.isPlaying(), false);
  assert.deepEqual(keysOf(animator), ['C', 'A', 'B']);
  assert.equal(ui.logCount, 0);
  await idle(player, 30);
  assert.deepEqual(tour.position(), { chapter: 1, beat: 2 });
  assert.deepEqual(keysOf(animator), ['C', 'A', 'B']);
  assert.equal(ui.logCount, 0, 'the interrupted operation never logs');
  tour.stepForward();
  await pump(player, () => !tour.isPlaying());
  assert.deepEqual(keysOf(animator), ['B', 'C', 'A']);
  assert.equal(ui.logCount, 1);
});

test('jumping to a paused chapter during an animating operation abandons it', async () => {
  const { tour, ui, player, animator } = setup({ opDuration: 1 });
  tour.start(1);
  await pump(player, () => tour.position().beat === 2 && player.busy);
  assert.deepEqual(keysOf(animator), ['B', 'C', 'A'], 'the model has already run get(B)');
  const captions = ui.captions.length;
  tour.start(3, { paused: true });
  assert.deepEqual(animator.state().snapshot, chapters[3].initial);
  await idle(player, 30);
  assert.deepEqual(animator.state().snapshot, chapters[3].initial);
  assert.equal(ui.logCount, 0, 'the abandoned operation never logs');
  assert.deepEqual(ui.captions.slice(captions), [''], 'only the jump itself touches the caption');
  assert.equal(player.busy, false, 'the abandoned run leaves nothing in the player');
});

test('jumping during a slow operation stops its step captions', async () => {
  const { tour, ui, player } = setup({ opDuration: 1 });
  tour.start(4);
  await pump(player, () => ui.captions.includes('Hash map: C found in one hop.'));
  assert.equal(player.busy, true);
  const captions = ui.captions.length;
  tour.start(2, { paused: true });
  await idle(player, 30);
  assert.deepEqual(ui.captions.slice(captions), ['']);
  assert.equal(ui.logCount, 0);
  assert.equal(player.busy, false);
});

test('stop silences step captions at once, even before the animator is reset', async () => {
  const { tour, ui, player } = setup({ opDuration: 1 });
  tour.start(4);
  await pump(player, () => ui.captions.includes('Hash map: C found in one hop.'));
  assert.equal(player.busy, true);
  const captions = ui.captions.length;
  tour.stop();
  await idle(player, 30);
  assert.equal(ui.captions.length, captions);
});

test('the scan counts checks', async () => {
  const { tour, ui, player } = setup();
  tour.start(2);
  await pump(player, () => ui.counter === 3);
  assert.equal(ui.counterLabel, 'checks');
});

test('jumping during the scan abandons it', async () => {
  const { tour, ui, player } = setup({ scanDuration: 1 });
  tour.start(2);
  await pump(player, () => ui.counter === 1 && player.busy);
  tour.start(0, { paused: true });
  assert.equal(ui.counter, null);
  await idle(player, 30);
  assert.equal(ui.counter, null, 'the abandoned scan does not bring the counter back');
  assert.equal(player.busy, false, 'the abandoned run leaves nothing in the player');
});

test('jumping during the recap card abandons it', async () => {
  const { tour, ui, player } = setup();
  tour.start(5);
  await pump(player, () => ui.card !== null);
  tour.start(4, { paused: true });
  assert.equal(ui.card, null);
  await idle(player, 30);
  assert.equal(ui.card, null, 'the abandoned card does not come back');
  assert.equal(player.busy, false, 'the abandoned run leaves nothing in the player');
});

test('stepForward with no operation left stops at the start of the next chapter', async () => {
  const { tour, ui, player, ended } = setup();
  tour.start(2, { paused: true });
  tour.stepForward();
  await pump(player, () => !tour.isPlaying());
  assert.deepEqual(tour.position(), { chapter: 3, beat: 0 });
  assert.equal(tour.isPlaying(), false);
  assert.deepEqual(ui.chapters, [2, 3]);
  assert.equal(ended(), false);
  assert.equal(ui.logCount, 0);
});

test('a chapter started paused does nothing until stepped', async () => {
  const { tour, ui, player } = setup();
  tour.start(1, { paused: true });
  await idle(player, 30);
  assert.equal(ui.logCount, 0);
  assert.deepEqual(tour.position(), { chapter: 1, beat: 0 });
  tour.stepForward();
  await pump(player, () => !tour.isPlaying());
  assert.equal(ui.logCount, 1);
});

test('stepBack during a first beat that has started restarts the chapter; a second press goes back a chapter', () => {
  const { tour } = setup();
  tour.start(2);
  // Playing: beat 0 passed the gate at once and is under way.
  tour.stepBack();
  assert.deepEqual(tour.position(), { chapter: 2, beat: 0 });
  assert.equal(tour.isPlaying(), false);
  // Now the run waits at the gate of beat 0, which has not started.
  tour.stepBack();
  assert.deepEqual(tour.position(), { chapter: 1, beat: 0 });
  assert.equal(tour.isPlaying(), false);
});

test('stepBack at a first beat that has not started goes to the previous chapter, paused', () => {
  const { tour } = setup();
  tour.start(2, { paused: true });
  tour.stepBack();
  assert.deepEqual(tour.position(), { chapter: 1, beat: 0 });
  assert.equal(tour.isPlaying(), false);
  tour.start(0, { paused: true });
  tour.stepBack();
  assert.deepEqual(tour.position(), { chapter: 0, beat: 0 }, 'chapter 1 stays at chapter 1');
});

test('stepBack during a first beat that has started restarts the chapter, not the previous one', async () => {
  const { tour, player } = setup();
  tour.start(3);
  await idle(player, 4);
  assert.deepEqual(tour.position(), { chapter: 3, beat: 0 });
  tour.stepBack();
  assert.deepEqual(tour.position(), { chapter: 3, beat: 0 });
  assert.equal(tour.isPlaying(), false);
});

test('after stepBack to an operation, the caption and current call show what will replay', async () => {
  const { tour, ui, player } = setup();
  tour.start(1);
  await pump(player, () => tour.position().beat === 4);
  tour.stepBack();
  // Beat 4 is get(C) with its own caption.
  assert.equal(ui.op, 'get(C)');
  assert.equal(ui.captions.at(-1), chapters[1].beats[4].caption);
});

test('after stepBack to an operation with no caption, the current call shows and the caption is empty', async () => {
  const { tour, ui, player } = setup();
  tour.start(4);
  await pump(player, () => tour.position().beat === 2);
  tour.stepBack();
  assert.deepEqual(tour.position(), { chapter: 4, beat: 2 });
  assert.equal(ui.op, 'get(X)');
  assert.equal(ui.captions.at(-1), '');
});

test('after stepBack to a beat that is not an operation, the caption shows that beat', async () => {
  const { tour, ui, player } = setup();
  tour.start(2);
  tour.stepBack();
  assert.equal(ui.captions.at(-1), chapters[2].beats[0].text);
  assert.equal(ui.op, null);
  tour.stepBack();
  assert.equal(ui.captions.at(-1), chapters[1].beats[0].text);
  tour.start(3);
  await idle(player, 2);
  tour.stepBack();
  assert.equal(ui.captions.at(-1), chapters[3].beats[0].caption);
});

test('togglePlaying flips between playing and paused', () => {
  const { tour, player } = setup();
  tour.start(0);
  tour.togglePlaying();
  assert.equal(tour.isPlaying(), false);
  assert.equal(player.paused, true);
  tour.togglePlaying();
  assert.equal(tour.isPlaying(), true);
  assert.equal(player.paused, false);
});

test('jumping to another chapter abandons the old run', async () => {
  const { tour, ui, player, ended } = setup();
  tour.start(0);
  await pump(player, () => tour.position().beat === 3);
  const captionsBefore = ui.captions.length;
  tour.start(3);
  await pump(player, ended);
  assert.deepEqual(ui.chapters, [0, 3, 4, 5]);
  const lastOfChapterOne = chapters[0].beats.at(-1).text;
  assert.ok(!ui.captions.slice(captionsBefore).includes(lastOfChapterOne));
});

test('stop halts the tour', async () => {
  const { tour, ui, player, animator, ended } = setup();
  tour.start(0);
  await pump(player, () => tour.position().beat === 2);
  tour.stop();
  animator.reset(4);
  const logged = ui.logCount;
  const captions = ui.captions.length;
  await idle(player, 100);
  assert.deepEqual(ui.chapters, [0]);
  assert.equal(ended(), false);
  assert.equal(ui.logCount, logged);
  assert.equal(ui.captions.length, captions);
  assert.deepEqual(animator.state().snapshot, { capacity: 4, entries: [] });
});
