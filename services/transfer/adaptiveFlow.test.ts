import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveAdaptiveFlow } from './adaptiveFlow.ts';

const noisyMetrics = {
  rttMs: 1_000,
  lossPct: 50,
  availableOutgoingBitrate: 100_000,
};

test('uses stable route windows instead of unreliable loss-driven tuning', () => {
  assert.deepEqual(
    deriveAdaptiveFlow({ isLan: true, isRelay: false, protocol: 'udp' }, noisyMetrics, 256 * 1024),
    { chunkSize: 128 * 1024, highWaterMark: 2 * 1024 * 1024, lowWaterMark: 512 * 1024 },
  );
  assert.deepEqual(
    deriveAdaptiveFlow({ isLan: false, isRelay: false, protocol: 'udp' }, noisyMetrics, 256 * 1024),
    { chunkSize: 64 * 1024, highWaterMark: 1024 * 1024, lowWaterMark: 256 * 1024 },
  );
  assert.deepEqual(
    deriveAdaptiveFlow({ isLan: false, isRelay: true, protocol: 'tcp' }, noisyMetrics, 256 * 1024),
    { chunkSize: 64 * 1024, highWaterMark: 1024 * 1024, lowWaterMark: 256 * 1024 },
  );
});

test('caps route chunk size at the negotiated SCTP maximum', () => {
  const lan = { isLan: true, isRelay: false, protocol: 'udp' };
  assert.equal(deriveAdaptiveFlow(lan, noisyMetrics).chunkSize, 64 * 1024);
  assert.equal(deriveAdaptiveFlow(lan, noisyMetrics, 16 * 1024).chunkSize, 16 * 1024);
  assert.equal(deriveAdaptiveFlow(lan, noisyMetrics, 64 * 1024).chunkSize, 64 * 1024);
  assert.equal(deriveAdaptiveFlow(lan, noisyMetrics, 256 * 1024).chunkSize, 128 * 1024);
});
