import test from 'node:test';
import assert from 'node:assert/strict';

test('receiver services load under native node esm resolution', async () => {
  const reconnectPolicy = await import('./committedReconnectPolicy.ts');
  const routeArbiter = await import('./routeArbiter.ts');

  assert.equal(typeof reconnectPolicy.getCommittedSessionReconnectDelayMs, 'function');
  assert.equal(typeof reconnectPolicy.shouldAutoReconnectCommittedSession, 'function');
  assert.equal(typeof routeArbiter.createReceiveRouteArbiter, 'function');
});
