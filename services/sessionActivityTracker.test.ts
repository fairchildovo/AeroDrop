import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionActivityTracker } from './sessionActivityTracker.ts';

test('begin returns monotonically increasing activity tokens', () => {
  const tracker = createSessionActivityTracker();

  const first = tracker.begin();
  const second = tracker.begin();

  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(tracker.current(), 2);
});

test('older tokens become stale once a newer activity starts', () => {
  const tracker = createSessionActivityTracker();

  const first = tracker.begin();
  const second = tracker.begin();

  assert.equal(tracker.isCurrent(first), false);
  assert.equal(tracker.isCurrent(second), true);
});
