import assert from 'node:assert/strict';
import test from 'node:test';

import { createTimeoutGroup } from './timeoutGroup.ts';

test('clearAll cancels every scheduled timeout exactly once', () => {
  const cleared: number[] = [];
  let nextId = 1;

  const group = createTimeoutGroup({
    set: () => nextId++,
    clear: (id) => {
      cleared.push(id);
    },
  });

  group.schedule(() => {}, 100);
  group.schedule(() => {}, 200);
  group.schedule(() => {}, 300);
  group.clearAll();

  assert.deepEqual(cleared, [1, 2, 3]);
  assert.equal(group.size(), 0);
});

test('clearing one timeout removes only that handle from the group', () => {
  const cleared: number[] = [];
  let nextId = 11;

  const group = createTimeoutGroup({
    set: () => nextId++,
    clear: (id) => {
      cleared.push(id);
    },
  });

  const first = group.schedule(() => {}, 100);
  group.schedule(() => {}, 200);

  group.clear(first);

  assert.deepEqual(cleared, [11]);
  assert.equal(group.size(), 1);
});
