import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getRouteSelectionTimings,
  pickPreferredRouteKind,
  type RouteSelectionContext,
} from './routeSelectionPolicy.ts';

test('desktop relay recommendation keeps all as primary and relay as background fallback', () => {
  const timings = getRouteSelectionTimings({
    isMobileDevice: false,
    isConstrained: false,
    relayRecommended: true,
  } satisfies RouteSelectionContext);

  assert.equal(timings.startAllImmediately, true);
  assert.equal(timings.startRelayDelayMs, 800);
  assert.equal(timings.p2pGraceWindowMs, 1500);
});

test('LAN direct outranks relay', () => {
  const winner = pickPreferredRouteKind(
    { isDirect: false, isLanDirect: false, kind: 'relay' },
    { isDirect: true, isLanDirect: true, kind: 'all' }
  );

  assert.equal(winner, 'all');
});
