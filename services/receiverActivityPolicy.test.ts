import assert from 'node:assert/strict';
import test from 'node:test';

import { TransferState } from '../types';
import {
  shouldHandleReceiverActivity,
  shouldRunReceiverScheduledReconnect,
} from './receiverActivityPolicy.ts';

test('stale receiver activity tokens block old connection events after reset', () => {
  assert.equal(
    shouldHandleReceiverActivity({
      activityToken: 3,
      currentActivityToken: 4,
    }),
    false
  );
});

test('queued reconnect callbacks only run for the current waiting session with a live peer', () => {
  assert.equal(
    shouldRunReceiverScheduledReconnect({
      activityToken: 5,
      currentActivityToken: 5,
      state: TransferState.WAITING_FOR_PEER,
      hasPeer: true,
      peerDestroyed: false,
    }),
    true
  );

  assert.equal(
    shouldRunReceiverScheduledReconnect({
      activityToken: 5,
      currentActivityToken: 6,
      state: TransferState.WAITING_FOR_PEER,
      hasPeer: true,
      peerDestroyed: false,
    }),
    false
  );

  assert.equal(
    shouldRunReceiverScheduledReconnect({
      activityToken: 5,
      currentActivityToken: 5,
      state: TransferState.ERROR,
      hasPeer: true,
      peerDestroyed: false,
    }),
    false
  );
});
