import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chapters } from '../src/chapters.js';
import { LRUCache } from '../src/lru.js';

const VIEWS = ['wide', 'row', 'map', 'head', 'tail'];
const short = (text) => typeof text === 'string' && [...text].length >= 1 && [...text].length <= 3;
const ops = (chapter) => chapter.beats.filter((beat) => beat.type === 'op');

function replay(chapter) {
  const cache = LRUCache.fromSnapshot(chapter.initial);
  const outcomes = [];
  for (const beat of ops(chapter)) {
    const { steps } = beat.op.type === 'get' ? cache.get(beat.op.key) : cache.put(beat.op.key, beat.op.value);
    const kind = steps.at(-1).kind;
    outcomes.push(kind === 'inserted' && steps.some((s) => s.type === 'evict') ? 'evicted' : kind);
  }
  return { end: cache.snapshot(), outcomes };
}

test('six chapters with unique ids and titles', () => {
  assert.equal(chapters.length, 6);
  assert.equal(new Set(chapters.map((c) => c.id)).size, 6);
  assert.equal(new Set(chapters.map((c) => c.title)).size, 6);
});

test('every chapter starts from a valid capacity-3 snapshot', () => {
  for (const chapter of chapters) {
    assert.equal(chapter.initial.capacity, 3, chapter.id);
    assert.doesNotThrow(() => LRUCache.fromSnapshot(chapter.initial), chapter.id);
    assert.equal(typeof chapter.internals, 'boolean', chapter.id);
    assert.ok(chapter.beats.length > 0, chapter.id);
  }
});

test('every beat is well formed', () => {
  for (const chapter of chapters) {
    chapter.beats.forEach((beat, i) => {
      const where = `${chapter.id}[${i}]`;
      if (beat.caption !== undefined) assert.ok(beat.caption.length <= 150, `${where} caption length`);
      switch (beat.type) {
        case 'caption':
          assert.ok(beat.text.length > 0 && beat.text.length <= 150, where);
          assert.ok(beat.hold > 0, where);
          break;
        case 'op':
          assert.ok(['get', 'put'].includes(beat.op.type), where);
          assert.ok(short(beat.op.key), where);
          if (beat.op.type === 'put') assert.ok(short(beat.op.value), where);
          assert.ok([undefined, 'slow', 'fast'].includes(beat.pace), where);
          break;
        case 'camera':
          assert.ok(VIEWS.includes(beat.view), where);
          break;
        case 'internals':
          assert.equal(typeof beat.visible, 'boolean', where);
          break;
        case 'scan':
          break;
        case 'card':
          assert.ok(beat.title.length > 0, where);
          assert.ok(beat.lines.length > 0, where);
          assert.ok(beat.hold > 0, where);
          break;
        default:
          assert.fail(`${where}: unknown beat type ${beat.type}`);
      }
    });
  }
});

test('chapters 2 to 4 pick up where the previous chapter ended', () => {
  for (const i of [1, 2, 3]) {
    assert.deepEqual(chapters[i].initial, replay(chapters[i - 1]).end, chapters[i].id);
  }
});

test('internals stay hidden until chapter 4 reveals them', () => {
  for (const i of [0, 1, 2]) {
    assert.equal(chapters[i].internals, false);
    assert.ok(!chapters[i].beats.some((beat) => beat.type === 'internals'));
  }
  assert.equal(chapters[3].internals, false);
  assert.ok(chapters[3].beats.some((beat) => beat.type === 'internals' && beat.visible === true));
  assert.equal(chapters[4].internals, true);
  assert.equal(chapters[5].internals, true);
});

test('chapter 1 shows a hit and a miss and fills the cache', () => {
  const { end, outcomes } = replay(chapters[0]);
  assert.ok(outcomes.includes('hit') && outcomes.includes('miss'));
  assert.equal(end.entries.length, 3);
});

test('chapter 2 shows eviction by recency', () => {
  assert.ok(replay(chapters[1]).outcomes.filter((o) => o === 'evicted').length >= 2);
});

test('chapter 3 runs the naive scan', () => {
  assert.ok(chapters[2].beats.some((beat) => beat.type === 'scan'));
});

test('chapter 5 walks one hit, one miss, one plain insert, one update and one eviction, all slow', () => {
  assert.ok(ops(chapters[4]).every((beat) => beat.pace === 'slow'));
  assert.deepEqual(replay(chapters[4]).outcomes.sort(), ['evicted', 'hit', 'inserted', 'miss', 'updated']);
});

test('chapter 6 is a fast run that ends on a recap card', () => {
  const chapter = chapters[5];
  assert.ok(ops(chapter).length >= 10);
  assert.ok(ops(chapter).every((beat) => beat.pace === 'fast'));
  const { outcomes } = replay(chapter);
  for (const kind of ['hit', 'miss', 'evicted', 'updated']) assert.ok(outcomes.includes(kind), kind);
  assert.equal(chapter.beats.at(-1).type, 'card');
});
