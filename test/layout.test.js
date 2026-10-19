import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_SPACING, BUCKET_COUNT, LIFT, slotX, recencyT, homeBucket, assignBucket, bucketPosition, viewFor,
} from '../src/scene/layout.js';

// Screen height of a world point for a camera looking from position at
// target (up is +y): the camera-space y over depth, so larger is higher.
function screenY({ position, target }, [x, y, z]) {
  const f = target.map((t, i) => t - position[i]);
  const fl = Math.hypot(...f);
  const fwd = f.map((v) => v / fl);
  // up' = worldUp minus its forward component, normalised.
  const up = [0 - fwd[1] * fwd[0], 1 - fwd[1] * fwd[1], 0 - fwd[1] * fwd[2]];
  const ul = Math.hypot(...up);
  const d = [x - position[0], y - position[1], z - position[2]];
  const depth = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
  return (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]) / ul / depth;
}

test('slots are centred on x = 0 and evenly spaced', () => {
  assert.equal(slotX(0, 1), 0);
  assert.equal(slotX(0, 3), -SLOT_SPACING);
  assert.equal(slotX(1, 3), 0);
  assert.equal(slotX(2, 3), SLOT_SPACING);
  assert.equal(slotX(0, 4), -slotX(3, 4));
});

test('recency runs from 0 at HEAD to 1 at the last slot', () => {
  assert.equal(recencyT(0, 4), 0);
  assert.equal(recencyT(3, 4), 1);
  assert.equal(recencyT(1, 3), 0.5);
  assert.equal(recencyT(0, 1), 0);
});

test('homeBucket is stable and in range', () => {
  for (const key of ['A', 'a', 'Z9', '<b>', '🔥']) {
    const bucket = homeBucket(key);
    assert.ok(Number.isInteger(bucket) && bucket >= 0 && bucket < BUCKET_COUNT, key);
    assert.equal(homeBucket(key), bucket);
  }
});

test('assignBucket probes past occupied cells', () => {
  const home = homeBucket('A');
  assert.equal(assignBucket('A', new Set()), home);
  assert.equal(assignBucket('A', new Set([home])), (home + 1) % BUCKET_COUNT);
  assert.equal(assignBucket('A', new Set([home, (home + 1) % BUCKET_COUNT])), (home + 2) % BUCKET_COUNT);
});

test('assignBucket returns -1 when the wall is full', () => {
  const all = new Set(Array.from({ length: BUCKET_COUNT }, (_, i) => i));
  assert.equal(assignBucket('A', all), -1);
});

test('eight keys always find eight distinct buckets', () => {
  const occupied = new Set();
  for (const key of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
    const bucket = assignBucket(key, occupied);
    assert.ok(bucket >= 0 && !occupied.has(bucket), key);
    occupied.add(bucket);
  }
});

test('bucket positions are distinct and sit behind and above the row', () => {
  const seen = new Set();
  for (let i = 0; i < BUCKET_COUNT; i++) {
    const { x, y, z } = bucketPosition(i);
    assert.ok(z < 0 && y > 2);
    seen.add(`${x},${y}`);
  }
  assert.equal(seen.size, BUCKET_COUNT);
});

test('the wide view backs off as capacity grows', () => {
  assert.ok(viewFor('wide', 8).position[2] > viewFor('wide', 3).position[2]);
});

test('from the wide view a lifted slab stays below the hash-map wall', () => {
  // The slab's top edge when lifted out of the row or created above HEAD
  // (slab height 2, plus its lifted bob), and the bottom edge of the wall's
  // lowest cells (cell height 0.96). Margin: 0.02 of the view height.
  const bottomRow = bucketPosition(BUCKET_COUNT - 1);
  for (let capacity = 2; capacity <= 8; capacity++) {
    const view = viewFor('wide', capacity);
    const slabTop = screenY(view, [slotX(0, capacity), LIFT + 1 + 0.12, 0.15]);
    const wallBottom = screenY(view, [slotX(0, capacity), bottomRow.y - 0.48, bottomRow.z]);
    assert.ok(wallBottom - slabTop > 0.02 * 0.83, `capacity ${capacity}: ${(wallBottom - slabTop).toFixed(3)}`);
  }
});

test('head and tail views look at the ends of the row', () => {
  assert.equal(viewFor('head', 4).target[0], slotX(0, 4));
  assert.equal(viewFor('tail', 4).target[0], slotX(3, 4));
});

test('every named view resolves and an unknown one throws', () => {
  for (const name of ['wide', 'row', 'map', 'head', 'tail']) {
    const view = viewFor(name, 4);
    assert.equal(view.position.length, 3);
    assert.equal(view.target.length, 3);
  }
  assert.throws(() => viewFor('nope', 4));
});
