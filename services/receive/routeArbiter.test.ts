import test from 'node:test';
import assert from 'node:assert/strict';

import { createReceiveRouteArbiter } from './routeArbiter.ts';

test('relay stays provisional until grace window expires', async () => {
  const events: string[] = [];
  const arbiter = createReceiveRouteArbiter({
    receiverSessionId: 'receiver-1',
    p2pGraceWindowMs: 100,
    onCommit: (kind) => events.push(`commit:${kind}`),
    now: () => 0,
    schedule: (ms, fn) => {
      events.push(`schedule:${ms}`);
      fn();
      return 1;
    },
    clearScheduled: () => {},
  });

  arbiter.markAttemptOpen('relay');

  assert.deepEqual(events, ['schedule:100', 'commit:relay']);
});

test('direct route beats provisional relay before deadline', () => {
  const commits: string[] = [];
  let scheduled: (() => void) | null = null;

  const arbiter = createReceiveRouteArbiter({
    receiverSessionId: 'receiver-2',
    p2pGraceWindowMs: 1000,
    onCommit: (kind) => commits.push(kind),
    now: () => 0,
    schedule: (_ms, fn) => {
      scheduled = fn;
      return 1;
    },
    clearScheduled: () => {
      scheduled = null;
    },
  });

  arbiter.markAttemptOpen('relay');
  arbiter.markAttemptOpen('all', { isDirect: true, isLanDirect: true });

  assert.deepEqual(commits, ['all']);
  assert.equal(scheduled, null);
});
