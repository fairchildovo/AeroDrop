import test from 'node:test';
import assert from 'node:assert/strict';

import { createReceiverSessionRegistry } from './receiverSessionRegistry.ts';

test('registry groups all and relay attempts under one receiver session', () => {
  const registry = createReceiverSessionRegistry();

  registry.registerAttempt({
    receiverSessionId: 'receiver-1',
    attemptId: 'a1',
    attemptKind: 'all',
    peerId: 'peer-all',
    connectionId: 'conn-all',
  });
  registry.registerAttempt({
    receiverSessionId: 'receiver-1',
    attemptId: 'a2',
    attemptKind: 'relay',
    peerId: 'peer-relay',
    connectionId: 'conn-relay',
  });

  const session = registry.getSession('receiver-1');
  assert.equal(session?.attempts.all?.connectionId, 'conn-all');
  assert.equal(session?.attempts.relay?.connectionId, 'conn-relay');
});

test('registry only resolves commit for the matching attempt and connection', () => {
  const registry = createReceiverSessionRegistry();

  registry.registerAttempt({
    receiverSessionId: 'receiver-1',
    attemptId: 'a1',
    attemptKind: 'all',
    peerId: 'peer-all',
    connectionId: 'conn-all',
  });

  assert.equal(registry.resolveAttemptForCommit('receiver-1', 'a1', 'conn-all'), true);
  assert.equal(registry.resolveAttemptForCommit('receiver-1', 'a1', 'conn-other'), false);
  assert.equal(registry.resolveAttemptForCommit('receiver-1', 'missing', 'conn-all'), false);
});

test('registry releases committed ownership when the connection closes', () => {
  const registry = createReceiverSessionRegistry();

  registry.registerAttempt({
    receiverSessionId: 'receiver-1',
    attemptId: 'a1',
    attemptKind: 'all',
    peerId: 'peer-all',
    connectionId: 'conn-all',
  });
  registry.markCommitted('receiver-1', 'conn-all');

  registry.releaseConnection('conn-all');

  const session = registry.getSession('receiver-1');
  assert.equal(session, undefined);
});
