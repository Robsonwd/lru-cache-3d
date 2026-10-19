class Node {
  constructor(key, value) {
    this.key = key;
    this.value = value;
    this.prev = null;
    this.next = null;
  }
}

// Hash map for O(1) lookup, doubly linked list for O(1) reordering.
// head.next is the most recently used entry; tail.prev is the least.
export class LRUCache {
  #capacity;
  #map = new Map();
  #head = new Node(null, null);
  #tail = new Node(null, null);

  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
    this.#capacity = capacity;
    this.#head.next = this.#tail;
    this.#tail.prev = this.#head;
  }

  get capacity() { return this.#capacity; }
  get size() { return this.#map.size; }

  get(key) {
    const node = this.#map.get(key);
    if (!node) {
      return {
        value: undefined,
        steps: [{ type: 'lookup', key, found: false }, { type: 'result', kind: 'miss' }],
      };
    }
    const steps = [{ type: 'lookup', key, found: true }];
    this.#touch(node, steps);
    steps.push({ type: 'result', kind: 'hit', value: node.value });
    return { value: node.value, steps };
  }

  put(key, value) {
    const existing = this.#map.get(key);
    if (existing) {
      const steps = [
        { type: 'lookup', key, found: true },
        { type: 'update', key, oldValue: existing.value, value },
      ];
      existing.value = value;
      this.#touch(existing, steps);
      steps.push({ type: 'result', kind: 'updated', value });
      return { steps };
    }
    const steps = [{ type: 'lookup', key, found: false }];
    if (this.#map.size >= this.#capacity) {
      const victim = this.#tail.prev;
      this.#unlink(victim);
      this.#map.delete(victim.key);
      steps.push({ type: 'evict', key: victim.key }, { type: 'mapDelete', key: victim.key });
    }
    const node = new Node(key, value);
    this.#linkAtHead(node);
    this.#map.set(key, node);
    steps.push(
      { type: 'create', key, value },
      { type: 'attachHead', key },
      { type: 'mapSet', key },
      { type: 'result', kind: 'inserted' },
    );
    return { steps };
  }

  snapshot() {
    const entries = [];
    for (let node = this.#head.next; node !== this.#tail; node = node.next) {
      entries.push({ key: node.key, value: node.value });
    }
    return { capacity: this.#capacity, entries };
  }

  static fromSnapshot({ capacity, entries }) {
    const cache = new LRUCache(capacity);
    if (entries.length > capacity) {
      throw new RangeError('snapshot has more entries than capacity');
    }
    // Insert tail-first so the first entry ends up at head.
    for (let i = entries.length - 1; i >= 0; i--) {
      if (cache.#map.has(entries[i].key)) {
        throw new RangeError(`snapshot has a duplicate key: ${entries[i].key}`);
      }
      const node = new Node(entries[i].key, entries[i].value);
      cache.#linkAtHead(node);
      cache.#map.set(node.key, node);
    }
    return cache;
  }

  #touch(node, steps) {
    if (this.#head.next === node) return;
    this.#unlink(node);
    this.#linkAtHead(node);
    steps.push({ type: 'detach', key: node.key }, { type: 'attachHead', key: node.key });
  }

  #unlink(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
    node.prev = null;
    node.next = null;
  }

  #linkAtHead(node) {
    node.next = this.#head.next;
    node.prev = this.#head;
    this.#head.next.prev = node;
    this.#head.next = node;
  }
}
