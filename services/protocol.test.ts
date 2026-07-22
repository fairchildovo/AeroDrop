import test from 'node:test';
import assert from 'node:assert/strict';

import { TRANSFER_CONFIG } from '../constants/transfer.ts';
import { createResumeRequestMessage, normalizeFileRequest } from './protocol.ts';

test('normalizes and preserves the receive credit window for resume requests', () => {
  const normalized = normalizeFileRequest({
    fileIndex: 2,
    byteOffset: 1024,
    receiveWindowBytes: 512 * 1024,
  });

  assert.equal(normalized.receiveWindowBytes, 512 * 1024);
  assert.deepEqual(createResumeRequestMessage(normalized).payload, {
    fileIndex: 2,
    byteOffset: 1024,
    silent: false,
    receiveWindowBytes: 512 * 1024,
  });
});

test('uses the receiver default credit window for missing legacy input', () => {
  assert.equal(
    normalizeFileRequest({ fileIndex: 0 }).receiveWindowBytes,
    TRANSFER_CONFIG.RECEIVE_WINDOW_BYTES
  );
});
