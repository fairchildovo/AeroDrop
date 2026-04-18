import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTransferMessage } from '../protocol.ts';
import { isCommittedTransferMessageType } from '../send/committedTransferGuard.ts';
import { createP2PMessage } from '../../types/index.ts';

test('committed transfer guard accepts normalized resume requests as file requests', () => {
  const normalized = normalizeTransferMessage(
    createP2PMessage('RESUME_REQUEST', {
      fileIndex: 2,
      byteOffset: 1024,
      silent: true,
    })
  );

  assert.equal(normalized.type, 'FILE_REQUEST');
  assert.equal(isCommittedTransferMessageType(normalized.type), true);
});

test('committed transfer guard ignores non-transfer route negotiation messages', () => {
  assert.equal(isCommittedTransferMessageType('ROUTE_COMMIT'), false);
});
