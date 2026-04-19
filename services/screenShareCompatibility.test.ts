import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPreferredScreenShareCodecOrder,
  getScreenShareBrowserProfile,
  shouldEnableLayeredScreenShareEncoding,
} from './screenShareCompatibility.ts';

test('prefers H264-first compatibility mode for iPhone Safari viewers', () => {
  const profile = getScreenShareBrowserProfile({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
    maxTouchPoints: 5,
  });

  assert.equal(profile.isIOSLike, true);
  assert.equal(profile.isWebKitLike, true);
  assert.equal(profile.isSafariLike, true);
  assert.equal(shouldEnableLayeredScreenShareEncoding(profile), false);
  assert.deepEqual(getPreferredScreenShareCodecOrder(profile), [
    'video/H264',
    'video/VP8',
    'video/VP9',
    'video/AV1',
  ]);
});

test('treats Chrome on iOS as WebKit compatibility mode', () => {
  const profile = getScreenShareBrowserProfile({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/135.0.7049.53 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
    maxTouchPoints: 5,
  });

  assert.equal(profile.isIOSLike, true);
  assert.equal(profile.isWebKitLike, true);
  assert.equal(profile.isSafariLike, false);
  assert.equal(shouldEnableLayeredScreenShareEncoding(profile), false);
  assert.equal(getPreferredScreenShareCodecOrder(profile)[0], 'video/H264');
});

test('keeps advanced codec order and layered encoding on desktop Chrome', () => {
  const profile = getScreenShareBrowserProfile({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    platform: 'Win32',
    maxTouchPoints: 0,
  });

  assert.equal(profile.isIOSLike, false);
  assert.equal(profile.isWebKitLike, false);
  assert.equal(profile.isSafariLike, false);
  assert.equal(shouldEnableLayeredScreenShareEncoding(profile), true);
  assert.deepEqual(getPreferredScreenShareCodecOrder(profile), [
    'video/AV1',
    'video/VP9',
    'video/H264',
    'video/VP8',
  ]);
});

test('detects iPadOS devices that masquerade as macOS', () => {
  const profile = getScreenShareBrowserProfile({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  });

  assert.equal(profile.isIOSLike, true);
  assert.equal(profile.prefersCompatibilityCodecs, true);
});
