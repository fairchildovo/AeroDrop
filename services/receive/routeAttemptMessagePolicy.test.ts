import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getNonWinningRouteMessageDisposition,
  isRouteAttemptTransferControlMessage,
} from './routeAttemptMessagePolicy.ts';

test('buffers transfer control messages while route arbitration is still in progress', () => {
  assert.equal(isRouteAttemptTransferControlMessage('METADATA'), true);
  assert.equal(
    getNonWinningRouteMessageDisposition({
      winnerCommitted: false,
      messageType: 'METADATA',
    }),
    'buffer'
  );
});

test('rejects transfer control messages on losing routes after a winner is committed', () => {
  assert.equal(isRouteAttemptTransferControlMessage('TRANSFER_CANCELLED'), true);
  assert.equal(
    getNonWinningRouteMessageDisposition({
      winnerCommitted: true,
      messageType: 'TRANSFER_CANCELLED',
    }),
    'reject'
  );
});

test('ignores non-transfer route messages', () => {
  assert.equal(isRouteAttemptTransferControlMessage('ROUTE_READY'), false);
});
