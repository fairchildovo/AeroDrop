import test from 'node:test';
import assert from 'node:assert/strict';

import { createRouteCommitGate } from './routeCommitGate.ts';

test('commit gate blocks metadata until session winner is committed', () => {
  const gate = createRouteCommitGate();

  assert.equal(gate.canSendMetadata('receiver-1'), false);
  gate.markCommitted('receiver-1', 'conn-all');
  assert.equal(gate.canSendMetadata('receiver-1'), true);
  assert.equal(gate.getCommittedConnectionId('receiver-1'), 'conn-all');
});

test('claimCommit distinguishes claimed duplicate and conflict states', () => {
  const gate = createRouteCommitGate();

  assert.deepEqual(gate.claimCommit('receiver-1', 'conn-all'), { status: 'claimed' });
  assert.deepEqual(gate.claimCommit('receiver-1', 'conn-all'), { status: 'duplicate' });
  assert.deepEqual(gate.claimCommit('receiver-1', 'conn-relay'), { status: 'conflict' });
});

test('releaseConnection allows the same receiver session to claim again', () => {
  const gate = createRouteCommitGate();

  gate.claimCommit('receiver-1', 'conn-all');
  gate.releaseConnection('conn-all');

  assert.equal(gate.canSendMetadata('receiver-1'), false);
  assert.deepEqual(gate.claimCommit('receiver-1', 'conn-relay'), { status: 'claimed' });
});
