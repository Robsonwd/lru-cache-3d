import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from '../src/lru.js';

const types = (steps) => steps.map((s) => s.type);
const keys = (cache) => cache.snapshot().entries.map((e) => e.key);

test('rejects a capacity that is not a positive integer', () => {
  for (const bad of [0, -1, 1.5, NaN, '3', undefined]) {
    assert.throws(() => new LRUCache(bad), RangeError);
  }
});

test('get on an empty cache is a miss', () => {
  const cache = new LRUCache(2);
  assert.deepEqual(cache.get('A'), {
    value: undefined,
    steps: [
      { type: 'lookup', key: 'A', found: false },
      { type: 'result', kind: 'miss' },
    ],
  });
});

test('put of a new key with free space inserts at head', () => {
  const cache = new LRUCache(2);
  assert.deepEqual(cache.put('A', '1').steps, [
    { type: 'lookup', key: 'A', found: false },
    { type: 'create', key: 'A', value: '1' },
    { type: 'attachHead', key: 'A' },
    { type: 'mapSet', key: 'A' },
    { type: 'result', kind: 'inserted' },
  ]);
  assert.deepEqual(cache.snapshot(), { capacity: 2, entries: [{ key: 'A', value: '1' }] });
  assert.equal(cache.size, 1);
  assert.equal(cache.capacity, 2);
});

test('get hit on a key that is not at head moves it to head', () => {
  const cache = new LRUCache(2);
  cache.put('A', '1');
  cache.put('B', '2');
  assert.deepEqual(cache.get('A'), {
    value: '1',
    steps: [
      { type: 'lookup', key: 'A', found: true },
      { type: 'detach', key: 'A' },
      { type: 'attachHead', key: 'A' },
      { type: 'result', kind: 'hit', value: '1' },
    ],
  });
  assert.deepEqual(keys(cache), ['A', 'B']);
});

test('get hit on the head key does not move it', () => {
  const cache = new LRUCache(2);
  cache.put('A', '1');
  cache.put('B', '2');
  assert.deepEqual(cache.get('B').steps, [
    { type: 'lookup', key: 'B', found: true },
    { type: 'result', kind: 'hit', value: '2' },
  ]);
  assert.deepEqual(keys(cache), ['B', 'A']);
});

test('put of an existing key updates the value and moves it to head', () => {
  const cache = new LRUCache(2);
  cache.put('A', '1');
  cache.put('B', '2');
  assert.deepEqual(cache.put('A', '9').steps, [
    { type: 'lookup', key: 'A', found: true },
    { type: 'update', key: 'A', oldValue: '1', value: '9' },
    { type: 'detach', key: 'A' },
    { type: 'attachHead', key: 'A' },
    { type: 'result', kind: 'updated', value: '9' },
  ]);
  assert.deepEqual(cache.snapshot().entries, [
    { key: 'A', value: '9' },
    { key: 'B', value: '2' },
  ]);
});

test('put of the head key updates in place without moving', () => {
  const cache = new LRUCache(2);
  cache.put('A', '1');
  cache.put('B', '2');
  assert.deepEqual(cache.put('B', '7').steps, [
    { type: 'lookup', key: 'B', found: true },
    { type: 'update', key: 'B', oldValue: '2', value: '7' },
    { type: 'result', kind: 'updated', value: '7' },
  ]);
  assert.deepEqual(keys(cache), ['B', 'A']);
  assert.equal(cache.get('B').value, '7');
});

test('put into a full cache evicts the tail first', () => {
  const cache = new LRUCache(2);
  cache.put('A', '1');
  cache.put('B', '2');
  assert.deepEqual(cache.put('C', '3').steps, [
    { type: 'lookup', key: 'C', found: false },
    { type: 'evict', key: 'A' },
    { type: 'mapDelete', key: 'A' },
    { type: 'create', key: 'C', value: '3' },
    { type: 'attachHead', key: 'C' },
    { type: 'mapSet', key: 'C' },
    { type: 'result', kind: 'inserted' },
  ]);
  assert.deepEqual(keys(cache), ['C', 'B']);
  assert.equal(cache.get('A').value, undefined);
  assert.equal(cache.size, 2);
});

test('eviction follows recency, not insertion order', () => {
  const cache = new LRUCache(2);
  cache.put('A', '1');
  cache.put('B', '2');
  cache.get('A');
  cache.put('C', '3');
  assert.deepEqual(keys(cache), ['C', 'A']);
});

test('capacity 1 evicts on every new key', () => {
  const cache = new LRUCache(1);
  cache.put('A', '1');
  assert.deepEqual(types(cache.put('B', '2').steps),
    ['lookup', 'evict', 'mapDelete', 'create', 'attachHead', 'mapSet', 'result']);
  assert.deepEqual(keys(cache), ['B']);
});

test('keys are case-sensitive', () => {
  const cache = new LRUCache(2);
  cache.put('a', '1');
  cache.put('A', '2');
  assert.equal(cache.get('a').value, '1');
  assert.equal(cache.get('A').value, '2');
});

test('snapshot round-trips through fromSnapshot and keeps working', () => {
  const cache = new LRUCache(3);
  cache.put('A', '1');
  cache.put('B', '2');
  cache.put('C', '3');
  cache.get('A');
  const copy = LRUCache.fromSnapshot(cache.snapshot());
  assert.deepEqual(copy.snapshot(), cache.snapshot());
  copy.put('D', '4');
  assert.deepEqual(keys(copy), ['D', 'A', 'C']);
  assert.deepEqual(keys(cache), ['A', 'C', 'B'], 'the original is untouched');
});

test('fromSnapshot rejects more entries than capacity', () => {
  assert.throws(
    () => LRUCache.fromSnapshot({ capacity: 1, entries: [{ key: 'A', value: '1' }, { key: 'B', value: '2' }] }),
    RangeError,
  );
});

test('fromSnapshot rejects a duplicate key', () => {
  assert.throws(
    () => LRUCache.fromSnapshot({ capacity: 2, entries: [{ key: 'A', value: '1' }, { key: 'A', value: '2' }] }),
    RangeError,
  );
});
