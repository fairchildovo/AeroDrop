import test from 'node:test';
import assert from 'node:assert/strict';

import { TransferState } from '../../types/index.ts';
import {
  getCommittedSessionReconnectDelayMs,
  shouldAutoReconnectCommittedSession,
  shouldReconnectStalledCommittedTransfer,
} from './committedReconnectPolicy.ts';

test('auto reconnect is allowed for committed peer-connected sessions', () => {
  assert.equal(
    shouldAutoReconnectCommittedSession({
      currentState: TransferState.PEER_CONNECTED,
      hasCode: true,
      intentionalClose: false,
    }),
    true
  );
});

test('auto reconnect is allowed for committed transferring sessions', () => {
  assert.equal(
    shouldAutoReconnectCommittedSession({
      currentState: TransferState.TRANSFERRING,
      hasCode: true,
      intentionalClose: false,
    }),
    true
  );
});

test('auto reconnect is blocked for intentional closes and non-committed states', () => {
  assert.equal(
    shouldAutoReconnectCommittedSession({
      currentState: TransferState.PEER_CONNECTED,
      hasCode: true,
      intentionalClose: true,
    }),
    false
  );
  assert.equal(
    shouldAutoReconnectCommittedSession({
      currentState: TransferState.WAITING_FOR_PEER,
      hasCode: true,
      intentionalClose: false,
    }),
    false
  );
  assert.equal(
    shouldAutoReconnectCommittedSession({
      currentState: TransferState.TRANSFERRING,
      hasCode: false,
      intentionalClose: false,
    }),
    false
  );
});

test('reconnect delay uses bounded backoff', () => {
  assert.equal(getCommittedSessionReconnectDelayMs(1), 600);
  assert.equal(getCommittedSessionReconnectDelayMs(2), 1200);
  assert.equal(getCommittedSessionReconnectDelayMs(10), 3000);
});

test('stalled committed transfer reconnects only after persisted progress stops', () => {
  const base = {
    currentState: TransferState.TRANSFERRING,
    transferActive: true,
    connectionOpen: true,
    lastProgressAtMs: 1_000,
    timeoutMs: 12_000,
  };

  assert.equal(shouldReconnectStalledCommittedTransfer({ ...base, nowMs: 12_999 }), false);
  assert.equal(shouldReconnectStalledCommittedTransfer({ ...base, nowMs: 13_000 }), true);
  assert.equal(shouldReconnectStalledCommittedTransfer({ ...base, nowMs: 20_000, transferActive: false }), false);
  assert.equal(shouldReconnectStalledCommittedTransfer({ ...base, nowMs: 20_000, connectionOpen: false }), false);
  assert.equal(shouldReconnectStalledCommittedTransfer({
    ...base,
    nowMs: 20_000,
    currentState: TransferState.PEER_CONNECTED,
  }), false);
});
