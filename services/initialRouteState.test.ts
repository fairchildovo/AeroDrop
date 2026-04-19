import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCREEN_SHARE_VIEW_SESSION_KEY,
  resolveInitialRouteState,
} from './initialRouteState.ts';

test('prefers file receive deep link over any stored screen share session', () => {
  const route = resolveInitialRouteState({
    search: '?code=4821',
    readSessionValue: (key) =>
      key === SCREEN_SHARE_VIEW_SESSION_KEY ? 'AERO-SHARE-01' : null,
  });

  assert.deepEqual(route, {
    code: '4821',
    hadDeepLink: true,
    mode: 'receive',
    viewId: '',
  });
});

test('restores screen share viewer session when url view param has been cleared', () => {
  const route = resolveInitialRouteState({
    search: '',
    readSessionValue: (key) =>
      key === SCREEN_SHARE_VIEW_SESSION_KEY ? 'AERO-SHARE-02' : null,
  });

  assert.deepEqual(route, {
    code: '',
    hadDeepLink: false,
    mode: 'screen',
    viewId: 'AERO-SHARE-02',
  });
});

test('uses current url view param for screen share deep links', () => {
  const route = resolveInitialRouteState({
    search: '?view=AERO-SHARE-03',
    readSessionValue: () => null,
  });

  assert.deepEqual(route, {
    code: '',
    hadDeepLink: true,
    mode: 'screen',
    viewId: 'AERO-SHARE-03',
  });
});

test('falls back to send mode when no file or screen deep link exists', () => {
  const route = resolveInitialRouteState({
    search: '',
    readSessionValue: () => null,
  });

  assert.deepEqual(route, {
    code: '',
    hadDeepLink: false,
    mode: 'send',
    viewId: '',
  });
});
