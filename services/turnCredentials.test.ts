import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSelfHostedTurnIceServer,
  getTurnTtlSeconds,
  omitTurnUdpIceServers,
  parseTurnUrls,
  selectReliableIceServers,
} from './turnCredentials.ts';

test('parses, deduplicates, and validates TURN URLs atomically', () => {
  assert.deepEqual(
    parseTurnUrls('turn:turn.example.com:3478?transport=udp,\nturns:turn.example.com:5349?transport=tcp,turn:turn.example.com:3478?transport=udp'),
    ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349?transport=tcp'],
  );
  assert.deepEqual(parseTurnUrls('turn:turn.example.com,https://example.com'), []);
  assert.deepEqual(parseTurnUrls(undefined), []);
});

test('defaults and clamps TURN credential TTL', () => {
  assert.equal(getTurnTtlSeconds(undefined), 3600);
  assert.equal(getTurnTtlSeconds('bad'), 3600);
  assert.equal(getTurnTtlSeconds('1'), 60);
  assert.equal(getTurnTtlSeconds('999999'), 86400);
});

test('omits default and explicit TURN UDP while preserving STUN, TCP, and TLS', () => {
  assert.deepEqual(omitTurnUdpIceServers([
    { urls: 'turn:turn.example.com:3478' },
    {
      urls: [
        'stun:stun.example.com:3478',
        'turn:turn.example.com:3478?transport=udp',
        'turn:turn.example.com:3478?transport=tcp',
        'turns:turn.example.com:5349?transport=tcp',
      ],
      username: 'short-lived',
    },
  ]), [
    {
      urls: [
        'stun:stun.example.com:3478',
        'turn:turn.example.com:3478?transport=tcp',
        'turns:turn.example.com:5349?transport=tcp',
      ],
      username: 'short-lived',
    },
  ]);
});

test('falls through providers when UDP filtering removes the primary TURN service', () => {
  assert.deepEqual(selectReliableIceServers([
    [{ urls: ['stun:primary.example.com', 'turn:primary.example.com?transport=udp'] }],
    [{ urls: 'turn:secondary.example.com?transport=tcp', username: 'secondary' }],
  ], [{ urls: 'stun:fallback.example.com' }]), [
    { urls: 'turn:secondary.example.com?transport=tcp', username: 'secondary' },
  ]);

  assert.deepEqual(selectReliableIceServers([
    [{ urls: 'turn:primary.example.com' }],
    [],
  ], [{ urls: 'stun:fallback.example.com' }]), [
    { urls: 'stun:fallback.example.com' },
  ]);
});

test('generates a coturn REST HMAC-SHA1 credential with a fixed expiry', async () => {
  const server = await createSelfHostedTurnIceServer({
    TURN_URLS: 'turn:turn.example.com:3478?transport=udp',
    TURN_SHARED_SECRET: 'test-secret',
    TURN_REALM: 'turn.example.com',
    TURN_TTL_SECONDS: '3600',
  }, 1_700_000_000);

  assert.deepEqual(server, {
    urls: 'turn:turn.example.com:3478?transport=udp',
    username: '1700003600:turn.example.com',
    credential: 'OL/gWiorJ6/q6v8+vrBj6+13IuY=',
  });
});

test('returns null for incomplete or invalid self-hosted TURN configuration', async () => {
  assert.equal(await createSelfHostedTurnIceServer({
    TURN_URLS: 'turn:turn.example.com',
    TURN_REALM: 'turn.example.com',
  }), null);
  assert.equal(await createSelfHostedTurnIceServer({
    TURN_URLS: 'https://turn.example.com',
    TURN_SHARED_SECRET: 'secret',
    TURN_REALM: 'turn.example.com',
  }), null);
});
