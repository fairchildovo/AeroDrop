import test from 'node:test';
import assert from 'node:assert/strict';

import { TransferState } from '../types/index.ts';
import { resolveDiagnosticsMode, shouldSuppressNoisyPeerError } from './diagnostics.ts';

test('resolveDiagnosticsMode stays off by default and enables explicit query or storage flags', () => {
  assert.equal(resolveDiagnosticsMode(), false);
  assert.equal(resolveDiagnosticsMode({ search: '?debugLogs=1' }), true);
  assert.equal(resolveDiagnosticsMode({ storedValue: 'true' }), true);
  assert.equal(resolveDiagnosticsMode({ search: '?debugLogs=false', storedValue: '0' }), false);
});

test('shouldSuppressNoisyPeerError only suppresses peer-unavailable once a session is already active', () => {
  assert.equal(
    shouldSuppressNoisyPeerError({
      errorType: 'peer-unavailable',
      transferState: TransferState.WAITING_FOR_PEER,
      activeConnections: 0,
    }),
    false
  );

  assert.equal(
    shouldSuppressNoisyPeerError({
      errorType: 'peer-unavailable',
      transferState: TransferState.TRANSFERRING,
      activeConnections: 1,
    }),
    true
  );

  assert.equal(
    shouldSuppressNoisyPeerError({
      errorType: 'webrtc-error',
      transferState: TransferState.TRANSFERRING,
      activeConnections: 1,
    }),
    false
  );
});
