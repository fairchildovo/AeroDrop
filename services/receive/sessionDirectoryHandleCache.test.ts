import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionDirectoryHandleCache } from './sessionDirectoryHandleCache.ts';

test('reuses an attached directory handle within the current session', async () => {
  const handle = { name: 'Downloads' } as FileSystemDirectoryHandle;
  const cache = createSessionDirectoryHandleCache();

  cache.remember(handle);

  assert.equal(cache.hasRememberedHandle(), true);
  assert.equal(cache.getRememberedHandle(), handle);
});

test('clears the remembered handle when validation fails', async () => {
  const handle = { name: 'Downloads' } as FileSystemDirectoryHandle;
  const cache = createSessionDirectoryHandleCache({
    validateHandle: async () => false,
  });

  cache.remember(handle);

  const reused = await cache.getReusableHandle();
  assert.equal(reused, null);
  assert.equal(cache.hasRememberedHandle(), false);
});

test('returns the remembered handle when validation succeeds', async () => {
  const handle = { name: 'Downloads' } as FileSystemDirectoryHandle;
  const cache = createSessionDirectoryHandleCache({
    validateHandle: async (candidate) => candidate === handle,
  });

  cache.remember(handle);

  const reused = await cache.getReusableHandle();
  assert.equal(reused, handle);
  assert.equal(cache.hasRememberedHandle(), true);
});
