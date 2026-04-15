import test from 'node:test';
import assert from 'node:assert/strict';

import { createReceiveRouteArbiter } from './routeArbiter.ts';

test('relay stays provisional until grace window expires', async () => {
  const events: string[] = [];
  const arbiter = createReceiveRouteArbiter({
    receiverSessionId: 'receiver-1',
    p2pGraceWindowMs: 100,
    onCommit: ({ kind, attemptId }) => events.push(`commit:${kind}:${attemptId}`),
    now: () => 0,
    schedule: (ms, fn) => {
      events.push(`schedule:${ms}`);
      fn();
      return 1;
    },
    clearScheduled: () => {},
  });

  arbiter.markAttemptReady('relay-1', 'relay');

  assert.deepEqual(events, ['schedule:100', 'commit:relay:relay-1']);
});

test('direct route beats provisional relay before deadline', () => {
  const commits: string[] = [];
  let scheduled: (() => void) | null = null;

  const arbiter = createReceiveRouteArbiter({
    receiverSessionId: 'receiver-2',
    p2pGraceWindowMs: 1000,
    onCommit: ({ kind, attemptId }) => commits.push(`${kind}:${attemptId}`),
    now: () => 0,
    schedule: (_ms, fn) => {
      scheduled = fn;
      return 1;
    },
    clearScheduled: () => {
      scheduled = null;
    },
  });

  arbiter.markAttemptReady('relay-1', 'relay');
  arbiter.markAttemptReady('all-1', 'all', { isDirect: true, isLanDirect: true });

  assert.deepEqual(commits, ['all:all-1']);
  assert.equal(scheduled, null);
});
