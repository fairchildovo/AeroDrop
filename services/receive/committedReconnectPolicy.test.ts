import test from 'node:test';
import assert from 'node:assert/strict';

import { TransferState } from '../../types';
import {
  getCommittedSessionReconnectDelayMs,
  shouldAutoReconnectCommittedSession,
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
