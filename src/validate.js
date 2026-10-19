export const MAX_LENGTH = 3;
export const MIN_CAPACITY = 2;
export const MAX_CAPACITY = 8;

function check(raw, field, label) {
  const text = String(raw ?? '').trim();
  if (text.length === 0) return { ok: false, field, message: `Enter a ${label}.` };
  if ([...text].length > MAX_LENGTH) {
    return { ok: false, field, message: `A ${label} is at most ${MAX_LENGTH} characters.` };
  }
  return { ok: true, text };
}

export function validateOp({ type, key, value }) {
  const checkedKey = check(key, 'key', 'key');
  if (!checkedKey.ok) return checkedKey;
  if (type === 'get') return { ok: true, op: { type: 'get', key: checkedKey.text } };
  const checkedValue = check(value, 'value', 'value');
  if (!checkedValue.ok) return checkedValue;
  return { ok: true, op: { type: 'put', key: checkedKey.text, value: checkedValue.text } };
}

export function validateCapacity(raw) {
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN_CAPACITY && n <= MAX_CAPACITY ? n : null;
}
