import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ease, tween, wait, call, seq, par, rate, Player } from '../src/timeline.js';

test('easings map 0 to 0 and 1 to 1', () => {
  for (const [name, fn] of Object.entries(ease)) {
    assert.ok(Math.abs(fn(0)) < 1e-9, `${name}(0)`);
    assert.ok(Math.abs(fn(1) - 1) < 1e-9, `${name}(1)`);
  }
});

test('tween reports progress and fires start and complete once', async () => {
  const calls = [];
  const player = new Player();
  const finished = player.play(tween({
    duration: 2,
    ease: ease.linear,
    onStart: () => calls.push('start'),
    onUpdate: (p) => calls.push(p),
    onComplete: () => calls.push('done'),
  }));
  player.update(1);
  player.update(1);
  player.update(1);
  assert.deepEqual(calls, ['start', 0.5, 1, 'done']);
  assert.equal(await finished, true);
  assert.equal(player.busy, false);
});

test('seq runs clips in order and does not start a clip early', () => {
  const calls = [];
  const player = new Player();
  player.play(seq(
    call(() => calls.push('a')),
    tween({ duration: 1, onComplete: () => calls.push('b') }),
    call(() => calls.push('c')),
  ));
  player.update(0.5);
  assert.deepEqual(calls, ['a']);
  player.update(0.5);
  assert.deepEqual(calls, ['a', 'b', 'c']);
});

test('one huge update still runs every callback once, in order', () => {
  const calls = [];
  const player = new Player();
  player.play(seq(
    tween({ duration: 1, onStart: () => calls.push('a-start'), onComplete: () => calls.push('a-done') }),
    call(() => calls.push('mid')),
    tween({ duration: 1, onStart: () => calls.push('b-start'), onComplete: () => calls.push('b-done') }),
  ));
  player.update(3600);
  player.update(1);
  assert.deepEqual(calls, ['a-start', 'a-done', 'mid', 'b-start', 'b-done']);
});

test('a clip completes before the next one starts, whatever the frame size', () => {
  for (const dt of [0.07, 0.013, 0.1, 0.33]) {
    const calls = [];
    const player = new Player();
    player.play(seq(
      tween({ duration: 0.1, onComplete: () => calls.push('a-done') }),
      tween({ duration: 0.2, onStart: () => calls.push('b-start'), onComplete: () => calls.push('b-done') }),
      call(() => calls.push('c')),
    ));
    for (let i = 0; i < 100; i++) player.update(dt);
    assert.deepEqual(calls, ['a-done', 'b-start', 'b-done', 'c'], `dt=${dt}`);
  }
});

test('par lasts as long as its longest clip', async () => {
  const calls = [];
  const player = new Player();
  const clip = par(
    tween({ duration: 1, onComplete: () => calls.push('short') }),
    tween({ duration: 3, onComplete: () => calls.push('long') }),
  );
  assert.equal(clip.duration, 3);
  const finished = player.play(clip);
  player.update(1);
  assert.deepEqual(calls, ['short']);
  player.update(2);
  assert.deepEqual(calls, ['short', 'long']);
  assert.equal(await finished, true);
});

test('rate scales a clip', () => {
  const calls = [];
  const clip = rate(tween({ duration: 4, onComplete: () => calls.push('done') }), 2);
  assert.equal(clip.duration, 2);
  const player = new Player();
  player.play(clip);
  player.update(1);
  assert.deepEqual(calls, []);
  player.update(1);
  assert.deepEqual(calls, ['done']);
});

test('a paused player does not advance, and speed scales time', () => {
  const calls = [];
  const player = new Player();
  player.play(tween({ duration: 2, onComplete: () => calls.push('done') }));
  player.paused = true;
  player.update(10);
  assert.deepEqual(calls, []);
  player.paused = false;
  player.speed = 2;
  player.update(1);
  assert.deepEqual(calls, ['done']);
});

test('cancelAll resolves false and stops callbacks', async () => {
  const calls = [];
  const player = new Player();
  const finished = player.play(seq(wait(1), call(() => calls.push('late'))));
  player.update(0.5);
  player.cancelAll();
  player.update(5);
  assert.equal(await finished, false);
  assert.deepEqual(calls, []);
  assert.equal(player.busy, false);
});

test('a callback may cancel the player during update', async () => {
  const player = new Player();
  const first = player.play(call(() => player.cancelAll()));
  const second = player.play(wait(5));
  player.update(1);
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(player.busy, false);
});

test('an empty seq finishes on the first update', async () => {
  const player = new Player();
  const finished = player.play(seq());
  player.update(0.016);
  assert.equal(await finished, true);
});

test('cancelAll inside a seq stops the rest of that seq', async () => {
  const calls = [];
  const player = new Player();
  const finished = player.play(seq(
    call(() => { calls.push('cancel'); player.cancelAll(); }),
    call(() => calls.push('after-cancel')),
    tween({ duration: 1, onStart: () => calls.push('next-start') }),
  ));
  player.update(0.016);
  assert.deepEqual(calls, ['cancel']);
  assert.equal(await finished, false);
  player.update(5);
  assert.deepEqual(calls, ['cancel']);
  assert.equal(player.busy, false);
});

test('cancelAll inside a seq stops the rest even on a huge frame', async () => {
  const calls = [];
  const player = new Player();
  const finished = player.play(seq(
    wait(1),
    call(() => { calls.push('cancel'); player.cancelAll(); }),
    call(() => calls.push('y')),
  ));
  player.update(3600);
  assert.deepEqual(calls, ['cancel']);
  assert.equal(await finished, false);
});

test("cancelAll inside a tween's onStart stops its onUpdate and onComplete", async () => {
  const calls = [];
  const player = new Player();
  const finished = player.play(tween({
    duration: 1,
    onStart: () => { calls.push('start'); player.cancelAll(); },
    onUpdate: () => calls.push('update'),
    onComplete: () => calls.push('done'),
  }));
  player.update(5);
  player.update(5);
  assert.deepEqual(calls, ['start']);
  assert.equal(await finished, false);
});

test('cancelAll inside a par stops the sibling clips that have not run yet', async () => {
  const calls = [];
  const player = new Player();
  const finished = player.play(par(
    call(() => { calls.push('cancel'); player.cancelAll(); }),
    call(() => calls.push('sibling')),
    tween({ duration: 1, onStart: () => calls.push('tween-start') }),
  ));
  player.update(0.016);
  player.update(5);
  assert.deepEqual(calls, ['cancel']);
  assert.equal(await finished, false);

  const nestedCalls = [];
  const nested = new Player();
  const nestedFinished = nested.play(seq(
    rate(seq(
      wait(0.5),
      par(
        call(() => { nestedCalls.push('cancel'); nested.cancelAll(); }),
        call(() => nestedCalls.push('sibling')),
      ),
      call(() => nestedCalls.push('after')),
    ), 2),
    call(() => nestedCalls.push('outer')),
  ));
  nested.update(3600);
  assert.deepEqual(nestedCalls, ['cancel']);
  assert.equal(await nestedFinished, false);
});

test('a clip played after a cancel runs normally', async () => {
  const calls = [];
  const player = new Player();
  const first = player.play(seq(
    call(() => player.cancelAll()),
    call(() => calls.push('stale')),
  ));
  player.update(0.016);
  assert.equal(await first, false);
  const second = player.play(seq(
    tween({ duration: 1, onStart: () => calls.push('start'), onComplete: () => calls.push('done') }),
    call(() => calls.push('after')),
  ));
  player.update(0.5);
  player.update(0.5);
  assert.deepEqual(calls, ['start', 'done', 'after']);
  assert.equal(await second, true);
  assert.equal(player.busy, false);
});
