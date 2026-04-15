import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveIceTransportPolicyDecision } from './iceConfigPolicy.ts';

test('keeps full candidate gathering but marks relay as recommended when TURN is available and network risk is detected', () => {
  const decision = resolveIceTransportPolicyDecision({
    hasTurn: true,
    isRisk: true,
    riskReason: 'network',
  });

  assert.deepEqual(decision, {
    iceTransportPolicy: 'all',
    relayRecommended: true,
    relayReason: 'network',
  });
});

test('keeps all candidates when TURN is unavailable even under network risk', () => {
  const decision = resolveIceTransportPolicyDecision({
    hasTurn: false,
    isRisk: true,
    riskReason: 'network',
  });

  assert.deepEqual(decision, {
    iceTransportPolicy: 'all',
    relayRecommended: false,
    relayReason: null,
  });
});

test('clears relay recommendation when the network is not risky', () => {
  const decision = resolveIceTransportPolicyDecision({
    hasTurn: true,
    isRisk: false,
    riskReason: 'location',
  });

  assert.deepEqual(decision, {
    iceTransportPolicy: 'all',
    relayRecommended: false,
    relayReason: null,
  });
});
