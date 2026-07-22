import test from 'node:test';
import assert from 'node:assert/strict';

import { createReceiveRecoveryCoordinator } from './recoveryCoordinator.ts';

test('resumeTransfer reopens the writer from the durably committed byte offset', async () => {
  const sentMessages: unknown[] = [];
  const reopenCalls: Array<{ fileIndex: number; byteOffset: number }> = [];

  const coordinator = createReceiveRecoveryCoordinator({
    maxAutoRepairRetries: 2,
    getConnection: () => ({
      open: true,
      send: (message: unknown) => {
        sentMessages.push(message);
      },
    }),
    setTransferActive: () => {},
    getCurrentFileIndex: () => 0,
    getReceivedSize: () => 12,
    getCommittedStreamBytes: () => 8,
    isFileCompleted: () => false,
    hasRetainedCurrentFileData: () => false,
    flushPendingStreamWrites: async () => true,
    reopenNativeWriterForResume: async (fileIndex: number, byteOffset: number) => {
      reopenCalls.push({ fileIndex, byteOffset });
      return true;
    },
    resetFileBuffersForRepair: () => {},
    resetHasherForRepair: async () => true,
    abortStreams: async () => {},
    awaitWriteQueue: async () => {},
    deleteIndexedDbChunksForFile: async () => {},
    setProgress: () => {},
    setDownloadSpeed: () => {},
    setDownloadSpeedBytes: () => {},
    setEta: () => {},
    setTransferState: () => {},
    setError: () => {},
    failTransferPersistence: (message: string) => {
      throw new Error(message);
    },
  } as any);

  await coordinator.resumeTransfer();

  assert.deepEqual(reopenCalls, [{ fileIndex: 0, byteOffset: 8 }]);
  assert.equal((sentMessages[0] as any)?.type, 'RESUME_REQUEST');
  assert.deepEqual((sentMessages[0] as any)?.payload, {
    fileIndex: 0,
    byteOffset: 8,
    silent: false,
    receiveWindowBytes: 2 * 1024 * 1024,
  });
});

test('resumeTransfer falls back to the received byte count when no durable offset is available', async () => {
  const sentMessages: unknown[] = [];

  const coordinator = createReceiveRecoveryCoordinator({
    maxAutoRepairRetries: 2,
    getConnection: () => ({
      open: true,
      send: (message: unknown) => {
        sentMessages.push(message);
      },
    }),
    setTransferActive: () => {},
    getCurrentFileIndex: () => 0,
    getReceivedSize: () => 12,
    isFileCompleted: () => false,
    hasRetainedCurrentFileData: () => false,
    flushPendingStreamWrites: async () => true,
    reopenNativeWriterForResume: async () => true,
    resetFileBuffersForRepair: () => {},
    resetHasherForRepair: async () => true,
    abortStreams: async () => {},
    awaitWriteQueue: async () => {},
    deleteIndexedDbChunksForFile: async () => {},
    setProgress: () => {},
    setDownloadSpeed: () => {},
    setDownloadSpeedBytes: () => {},
    setEta: () => {},
    setTransferState: () => {},
    setError: () => {},
    failTransferPersistence: (message: string) => {
      throw new Error(message);
    },
  });

  await coordinator.resumeTransfer();

  assert.equal((sentMessages[0] as any)?.payload?.byteOffset, 12);
});
