import test from 'node:test';
import assert from 'node:assert/strict';

import { createHappyEyeballsPlan } from './connectionPolicy.ts';
import type { BrowserNetworkProfile } from './networkProfile.ts';
import type { IceConfigResult } from './stunService.ts';

const baseIceConfig = (overrides: Partial<IceConfigResult> = {}): IceConfigResult => ({
  iceServers: [{ urls: 'turn:example.com?transport=udp' }],
  secure: true,
  iceCandidatePoolSize: 20,
  iceTransportPolicy: 'all',
  hasTurn: true,
  relayRecommended: false,
  relayReason: null,
  fetchLatencyMs: 200,
  ...overrides,
});

const baseProfile = (overrides: Partial<BrowserNetworkProfile> = {}): BrowserNetworkProfile => ({
  isMobileDevice: false,
  connectionType: 'unknown',
  effectiveType: '4g',
  saveData: false,
  rtt: 50,
  downlink: 30,
  isLikelyMobileNetwork: false,
  isConstrained: false,
  profileKey: 'desktop',
  ...overrides,
});

const options = {
  defaultInitialTimeoutMs: 15000,
  relayInitialTimeoutMs: 25000,
  relayParallelDelayMs: 1200,
  p2pBackfillDelayMs: 2200,
};

test('desktop relay recommendation keeps all as primary and relay as background fallback', () => {
  const plan = createHappyEyeballsPlan(
    baseIceConfig({
      relayRecommended: true,
      relayReason: 'network',
    }),
    baseProfile(),
    options
  );

  assert.equal(plan.initialPolicy, 'all');
  assert.equal(plan.backgroundPolicy, 'relay');
  assert.equal(plan.reason, 'relay_recommended');
});

test('desktop normal network keeps all as the only initial route when no prewarm is needed', () => {
  const plan = createHappyEyeballsPlan(
    baseIceConfig({
      relayRecommended: false,
      relayReason: null,
      fetchLatencyMs: 200,
    }),
    baseProfile(),
    options
  );

  assert.equal(plan.initialPolicy, 'all');
  assert.equal(plan.backgroundPolicy, null);
  assert.equal(plan.backgroundDelayMs, null);
  assert.equal(plan.reason, 'default');
});

test('constrained mobile network keeps all first and relay as fast background fallback', () => {
  const plan = createHappyEyeballsPlan(
    baseIceConfig({
      relayRecommended: true,
      relayReason: 'network',
    }),
    baseProfile({
      isMobileDevice: true,
      connectionType: 'cellular',
      effectiveType: '3g',
      isLikelyMobileNetwork: true,
      isConstrained: true,
      profileKey: 'mobile',
    }),
    options
  );

  assert.equal(plan.initialPolicy, 'all');
  assert.equal(plan.backgroundPolicy, 'relay');
  assert.equal(plan.reason, 'mobile_network');
});
