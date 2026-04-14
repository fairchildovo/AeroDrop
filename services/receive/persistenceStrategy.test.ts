import test from 'node:test';
import assert from 'node:assert/strict';

import { decidePersistenceStrategy } from './persistenceStrategy.ts';

test('prefers native fs for desktop when available', () => {
  const strategy = decidePersistenceStrategy({
    isIOS: false,
    isSafari: false,
    preferBrowserDownload: true,
    supportsNativeFs: true,
    supportsStreamSaver: true,
    supportsIndexedDb: true,
    fileSize: 1024,
    indexedDbThresholdBytes: 10 * 1024 * 1024,
  });

  assert.equal(strategy, 'native-fs');
});

test('falls back to stream saver on desktop when native fs is unavailable', () => {
  const strategy = decidePersistenceStrategy({
    isIOS: false,
    isSafari: false,
    supportsNativeFs: false,
    supportsStreamSaver: true,
    supportsIndexedDb: true,
    fileSize: 1024,
    indexedDbThresholdBytes: 10 * 1024 * 1024,
  });

  assert.equal(strategy, 'stream-saver');
});

test('uses indexeddb buffer for large ios files', () => {
  const strategy = decidePersistenceStrategy({
    isIOS: true,
    isSafari: false,
    supportsNativeFs: false,
    supportsStreamSaver: false,
    supportsIndexedDb: true,
    fileSize: 20 * 1024 * 1024,
    indexedDbThresholdBytes: 10 * 1024 * 1024,
  });

  assert.equal(strategy, 'indexeddb-buffer');
});

test('falls back to memory blob when no streaming path is available', () => {
  const strategy = decidePersistenceStrategy({
    isIOS: false,
    isSafari: false,
    supportsNativeFs: false,
    supportsStreamSaver: false,
    supportsIndexedDb: false,
    fileSize: 1024,
    indexedDbThresholdBytes: 10 * 1024 * 1024,
  });

  assert.equal(strategy, 'memory-blob');
});
