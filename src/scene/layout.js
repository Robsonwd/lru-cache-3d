// Pure layout maths. No three.js import, so it runs under node --test.
export const SLOT_SPACING = 2.2;
export const BUCKET_COUNT = 12;
export const LIFT = 2.0;

const BUCKET_COLUMNS = 6;
const WALL_Z = -4;

export function slotX(index, capacity) {
  return (index - (capacity - 1) / 2) * SLOT_SPACING;
}

export function recencyT(index, capacity) {
  return capacity <= 1 ? 0 : index / (capacity - 1);
}

export function homeBucket(key) {
  let hash = 0;
  for (const ch of String(key)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % BUCKET_COUNT;
}

export function assignBucket(key, occupied) {
  let index = homeBucket(key);
  for (let probes = 0; probes < BUCKET_COUNT; probes++) {
    if (!occupied.has(index)) return index;
    index = (index + 1) % BUCKET_COUNT;
  }
  return -1;
}

export function bucketPosition(index) {
  const column = index % BUCKET_COLUMNS;
  const row = Math.floor(index / BUCKET_COLUMNS);
  return { x: (column - (BUCKET_COLUMNS - 1) / 2) * 1.6, y: 4.6 - row * 1.2, z: WALL_Z };
}

export function viewFor(name, capacity) {
  const wideZ = Math.max(13, capacity * 2.6 + 3);
  switch (name) {
    // A crane shot about 16 degrees down. The height matters: from this angle
    // a slab lifted out of the row (LIFT) or created above HEAD stays below
    // the wall's bottom row on screen, so the wall stays readable during
    // every move. The offset scales with k, as row and map do, so the same
    // holds at every capacity.
    case 'wide': {
      const k = wideZ / 13;
      return { position: [0, 1.4 + 4.2 * k, -1.5 + 14.3 * k], target: [0, 1.4, -1.5] };
    }
    // Row and map are framed for the overlay's clear area (below the top bar,
    // above the caption, left of the readout), so both sit a little left of
    // centre. k scales the camera distance with the row's width.
    case 'row': {
      const k = wideZ / 13;
      return { position: [0.75, 0.8 + 0.2 * k, 11.5 * k], target: [0.75, 0.8, 0] };
    }
    case 'map': {
      const k = wideZ / 13;
      return { position: [0.75, 1.4 + 7.6 * k, -2 + 13.25 * k], target: [0.75, 1.4, -2] };
    }
    case 'head': return { position: [slotX(0, capacity) - 1.5, 1.8, 7], target: [slotX(0, capacity), 0.3, 0] };
    case 'tail': {
      const x = slotX(capacity - 1, capacity);
      return { position: [x + 1.5, 1.8, 7], target: [x, 0.3, 0] };
    }
    default: throw new Error(`unknown view: ${name}`);
  }
}
