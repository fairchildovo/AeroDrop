import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSignalingRateLimiter,
  isFourDigitSharePeerId,
} from './signalingRateLimitPolicy.ts';

test('only four digit AeroDrop share peer ids are treated as guessable targets', () => {
  assert.equal(isFourDigitSharePeerId('aerodrop-1234'), true);
  assert.equal(isFourDigitSharePeerId('aerodrop-123'), false);
  assert.equal(isFourDigitSharePeerId('aerodrop-12345'), false);
  assert.equal(isFourDigitSharePeerId('peer-random'), false);
});

test('limits repeated four digit share attempts from the same client', () => {
  const limiter = createSignalingRateLimiter({
    blockMs: 10_000,
    maxAttemptsPerClientWindow: 2,
    maxAttemptsPerTargetWindow: 10,
    windowMs: 1_000,
  });

  assert.equal(limiter.recordOfferAttempt({
    clientKey: 'ip:203.0.113.10',
    now: 1_000,
    targetPeerId: 'aerodrop-1000',
  }).allowed, true);
  assert.equal(limiter.recordOfferAttempt({
    clientKey: 'ip:203.0.113.10',
    now: 1_100,
    targetPeerId: 'aerodrop-1001',
  }).allowed, true);

  const blocked = limiter.recordOfferAttempt({
    clientKey: 'ip:203.0.113.10',
    now: 1_200,
    targetPeerId: 'aerodrop-1002',
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'client-rate-limited');
});

test('limits aggregate guessing pressure against one four digit share code', () => {
  const limiter = createSignalingRateLimiter({
    blockMs: 10_000,
    maxAttemptsPerClientWindow: 10,
    maxAttemptsPerTargetWindow: 2,
    windowMs: 1_000,
  });

  assert.equal(limiter.recordOfferAttempt({
    clientKey: 'ip:203.0.113.10',
    now: 1_000,
    targetPeerId: 'aerodrop-1000',
  }).allowed, true);
  assert.equal(limiter.recordOfferAttempt({
    clientKey: 'ip:203.0.113.11',
    now: 1_100,
    targetPeerId: 'aerodrop-1000',
  }).allowed, true);

  const blocked = limiter.recordOfferAttempt({
    clientKey: 'ip:203.0.113.12',
    now: 1_200,
    targetPeerId: 'aerodrop-1000',
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'target-rate-limited');
});

test('does not count non share peer targets', () => {
  const limiter = createSignalingRateLimiter({
    blockMs: 10_000,
    maxAttemptsPerClientWindow: 1,
    maxAttemptsPerTargetWindow: 1,
    windowMs: 1_000,
  });

  assert.equal(limiter.recordOfferAttempt({
    clientKey: 'ip:203.0.113.10',
    now: 1_000,
    targetPeerId: 'peer-random',
  }).tracked, false);
  assert.equal(limiter.recordOfferAttempt({
    clientKey: 'ip:203.0.113.10',
    now: 1_100,
    targetPeerId: 'aerodrop-1000',
  }).allowed, true);
});
