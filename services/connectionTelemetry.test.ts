import test from 'node:test';
import assert from 'node:assert/strict';

import { getIceRoute } from './connectionTelemetry.ts';

const createPeerConnection = (local: Record<string, unknown>, remote: Record<string, unknown>) => {
  const stats = new Map<string, Record<string, unknown>>([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', {
      type: 'candidate-pair',
      localCandidateId: 'local',
      remoteCandidateId: 'remote',
      currentRoundTripTime: 0.012,
    }],
    ['local', local],
    ['remote', remote],
  ]);
  return {
    connectionState: 'connected',
    getStats: async () => stats,
  } as unknown as RTCPeerConnection;
};

test('ICE telemetry uses shared IPv6 LAN classification', async () => {
  const route = await getIceRoute(createPeerConnection(
    { address: '[fe80::1]:5000', candidateType: 'host', protocol: 'udp' },
    { address: 'fd12:3456::2', candidateType: 'host', protocol: 'udp' },
  ));

  assert.equal(route?.pathType, 'LAN');
  assert.equal(route?.rttMs, 12);
});

test('ICE telemetry classifies relay candidates as TURN', async () => {
  const route = await getIceRoute(createPeerConnection(
    { address: '203.0.113.10', candidateType: 'relay', protocol: 'udp' },
    { address: '192.168.1.2', candidateType: 'host', protocol: 'udp' },
  ));

  assert.equal(route?.pathType, 'TURN');
});
