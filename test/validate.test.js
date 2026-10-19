import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOp, validateCapacity } from '../src/validate.js';

test('a valid get is trimmed and returned as an op', () => {
  assert.deepEqual(validateOp({ type: 'get', key: '  A ' }), { ok: true, op: { type: 'get', key: 'A' } });
});

test('a valid put carries key and value', () => {
  assert.deepEqual(validateOp({ type: 'put', key: 'A', value: ' 12 ' }),
    { ok: true, op: { type: 'put', key: 'A', value: '12' } });
});

test('get ignores the value field', () => {
  assert.deepEqual(validateOp({ type: 'get', key: 'A', value: 'far too long' }),
    { ok: true, op: { type: 'get', key: 'A' } });
});

test('an empty or blank key is rejected', () => {
  for (const key of ['', '   ', undefined, null]) {
    const result = validateOp({ type: 'get', key });
    assert.equal(result.ok, false);
    assert.equal(result.field, 'key');
    assert.ok(result.message.length > 0);
  }
});

test('put with an empty value is rejected on the value field', () => {
  const result = validateOp({ type: 'put', key: 'A', value: ' ' });
  assert.equal(result.ok, false);
  assert.equal(result.field, 'value');
});

test('more than three characters is rejected', () => {
  assert.equal(validateOp({ type: 'get', key: 'ABCD' }).field, 'key');
  assert.equal(validateOp({ type: 'put', key: 'A', value: '1234' }).field, 'value');
});

test('length is counted in code points, so three emoji fit', () => {
  assert.equal(validateOp({ type: 'get', key: '🔥🔥🔥' }).ok, true);
  assert.equal(validateOp({ type: 'get', key: '🔥🔥🔥🔥' }).ok, false);
});

test('markup is kept as literal text and case is preserved', () => {
  assert.deepEqual(validateOp({ type: 'get', key: '<b>' }).op, { type: 'get', key: '<b>' });
  assert.deepEqual(validateOp({ type: 'get', key: 'a' }).op, { type: 'get', key: 'a' });
});

test('capacity accepts integers from 2 to 8', () => {
  assert.equal(validateCapacity('4'), 4);
  assert.equal(validateCapacity(2), 2);
  assert.equal(validateCapacity(8), 8);
  for (const bad of ['1', '9', '3.5', 'abc', '', null]) assert.equal(validateCapacity(bad), null);
});
