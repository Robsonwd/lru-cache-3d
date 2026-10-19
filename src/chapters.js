const say = (text, hold) => ({ type: 'caption', text, hold });
const get = (key, extra = {}) => ({ type: 'op', op: { type: 'get', key }, ...extra });
const put = (key, value, extra = {}) => ({ type: 'op', op: { type: 'put', key, value }, ...extra });
const entry = (key, value) => ({ key, value });
const slow = { pace: 'slow' };
const fast = { pace: 'fast' };

export const chapters = [
  {
    id: 'why',
    title: 'Why cache',
    initial: { capacity: 3, entries: [] },
    internals: false,
    beats: [
      say('Reading from a database or the network is slow.', 3),
      say('A cache keeps recent answers in fast memory, so asking again is instant.', 3.5),
      put('A', '1', { caption: 'put(A, 1) stores an answer under its key.' }),
      put('B', '2', { caption: 'put(B, 2) stores another.' }),
      get('A', { caption: 'get(A): it is here. That is a hit, and A is now the most recently used.' }),
      get('Z', { caption: 'get(Z): it is not here. That is a miss, and the slow source has to answer.' }),
      say('Memory is limited. This cache has room for 3 entries.', 3.5),
      put('C', '3', { caption: 'put(C, 3) takes the last free slot. The cache is full.' }),
      say('The next new key needs a slot. Which entry should leave?', 4),
    ],
  },
  {
    id: 'rule',
    title: 'The rule',
    initial: { capacity: 3, entries: [entry('C', '3'), entry('A', '1'), entry('B', '2')] },
    internals: false,
    beats: [
      say('LRU stands for Least Recently Used: evict the entry that has gone longest without being touched.', 4.5),
      say('Brightness shows recency. The entry at HEAD was used last. The entry at TAIL is next to go.', 4.5),
      get('B', { caption: 'get(B): using an entry moves it to HEAD.' }),
      put('D', '4', { caption: 'put(D, 4): the cache is full, so A at TAIL is evicted.' }),
      get('C', { caption: 'get(C): C moves to HEAD. Now B is the oldest.' }),
      put('E', '5', { caption: 'put(E, 5): B has gone longest unused, so B leaves.' }),
      say('That is the whole rule. The hard part is doing it fast.', 4),
    ],
  },
  {
    id: 'naive',
    title: 'The naive way',
    initial: { capacity: 3, entries: [entry('E', '5'), entry('C', '3'), entry('D', '4')] },
    internals: false,
    beats: [
      say('A simple cache has no such order. Each entry only carries a last-used timestamp. The row is sorted here so you can follow it.', 5.5),
      { type: 'scan', caption: 'To find the least recently used entry, it has to check every timestamp.', hold: 2 },
      say('3 entries took 3 checks. A million entries would take a million, on every eviction. That is O(n).', 5),
      say('Keeping the array sorted by recency means shifting entries on every access. Still O(n).', 4.5),
      say('The goal: get and put in O(1), the same cost however large the cache grows.', 4.5),
    ],
  },
  {
    id: 'machinery',
    title: 'The machinery',
    initial: { capacity: 3, entries: [entry('E', '5'), entry('C', '3'), entry('D', '4')] },
    internals: false,
    beats: [
      { type: 'internals', visible: true, caption: 'Two data structures do it together.', hold: 3 },
      { type: 'camera', view: 'map', hold: 5,
        caption: 'A hash map: every key points straight at its entry. Finding one takes a single hop.' },
      { type: 'camera', view: 'row', hold: 5.5,
        caption: 'A doubly linked list: every entry points at both neighbours. The list holds the order, HEAD to TAIL.' },
      say('Knowing both neighbours, an entry can be unlinked and relinked by changing a few pointers. No scanning. No shifting.', 5.5),
      { type: 'camera', view: 'wide', hold: 4,
        caption: 'The hash map finds. The linked list reorders. Now watch them work.' },
    ],
  },
  {
    id: 'steps',
    title: 'Step by step',
    initial: { capacity: 3, entries: [entry('E', '5'), entry('C', '3')] },
    internals: true,
    beats: [
      say('Each operation is a handful of pointer changes. Here they are, slowed down, starting with one slot free.', 4),
      get('C', slow),
      get('X', slow),
      put('F', '6', slow),
      put('C', '9', slow),
      put('G', '7', slow),
      say('Each operation touched at most two hash-map entries and a few pointers. None of it depended on the size of the cache.', 5),
    ],
  },
  {
    id: 'run',
    title: 'Full run',
    initial: { capacity: 3, entries: [] },
    internals: true,
    beats: [
      say('A longer run at full speed. Watch the hit and miss counters.', 3),
      put('A', '1', fast),
      put('B', '2', fast),
      put('C', '3', fast),
      get('A', fast),
      put('D', '4', fast),
      get('B', fast),
      get('C', fast),
      put('E', '5', fast),
      get('A', fast),
      get('D', fast),
      put('C', '8', fast),
      put('F', '6', fast),
      get('E', fast),
      get('D', fast),
      {
        type: 'card',
        title: 'LRU cache: the whole idea',
        lines: [
          'get(key): find it through the hash map, move it to HEAD. O(1).',
          'put(key, value): update or insert at HEAD. If full, evict TAIL. O(1).',
          'The hash map finds in O(1) on average. The doubly linked list reorders in O(1).',
          'Next: the sandbox. Predict, then test.',
        ],
        hold: 9,
      },
    ],
  },
];
