import test from 'node:test';
import assert from 'node:assert/strict';

import { createReceivePersistenceOrchestrator } from './persistenceOrchestrator.ts';

test('finalizeCurrentFile flushes streaming writes before closing and marking persisted', async () => {
  const events: string[] = [];

  const orchestrator = createReceivePersistenceOrchestrator({
    getState: () => 'TRANSFERRING',
    isTransferActive: () => true,
    getCurrentFileIndex: () => 0,
    isIndexedDbBuffering: () => false,
    isStreaming: () => true,
    takeIndexedDbBatch: () => ({ batch: [], size: 0 }),
    flushIndexedDbBatch: async () => {
      throw new Error('should not flush indexeddb');
    },
    takeStreamBatch: () => ({
      batch: [new Uint8Array([1, 2, 3])],
      size: 3,
    }),
    flushSpecificBatch: async (_batch, totalLen) => {
      events.push(`flush:${totalLen}`);
    },
    enqueueWrite: async (task) => {
      events.push('enqueue:start');
      await task();
      events.push('enqueue:end');
    },
    closeStreams: async () => {
      events.push('close');
      return true;
    },
    saveCurrentFile: async () => {
      events.push('save');
      return true;
    },
    markCurrentFilePersisted: (fileName) => {
      events.push(`persist:${fileName}`);
    },
    failTransferPersistence: (message) => {
      events.push(`fail:${message}`);
    },
  });

  await orchestrator.finalizeCurrentFile('demo.bin');

  assert.deepEqual(events, [
    'enqueue:start',
    'flush:3',
    'close',
    'enqueue:end',
    'enqueue:start',
    'persist:demo.bin',
    'enqueue:end',
  ]);
});

test('finalizeCurrentFile saves indexeddb-backed files before marking persisted', async () => {
  const events: string[] = [];

  const orchestrator = createReceivePersistenceOrchestrator({
    getState: () => 'TRANSFERRING',
    isTransferActive: () => true,
    getCurrentFileIndex: () => 2,
    isIndexedDbBuffering: () => true,
    isStreaming: () => false,
    takeIndexedDbBatch: () => ({
      batch: [new ArrayBuffer(4)],
      size: 4,
    }),
    flushIndexedDbBatch: async (fileIndex, _batch, totalLen) => {
      events.push(`idb-flush:${fileIndex}:${totalLen}`);
    },
    takeStreamBatch: () => ({ batch: [], size: 0 }),
    flushSpecificBatch: async () => {
      throw new Error('should not flush stream batch');
    },
    enqueueWrite: async (task) => {
      events.push('enqueue');
      await task();
    },
    closeStreams: async () => {
      events.push('close');
      return true;
    },
    saveCurrentFile: async () => {
      events.push('save');
      return true;
    },
    markCurrentFilePersisted: (fileName) => {
      events.push(`persist:${fileName}`);
    },
    failTransferPersistence: (message) => {
      events.push(`fail:${message}`);
    },
  });

  await orchestrator.finalizeCurrentFile('buffered.bin');

  assert.deepEqual(events, [
    'enqueue',
    'idb-flush:2:4',
    'enqueue',
    'enqueue',
    'save',
    'persist:buffered.bin',
  ]);
});
