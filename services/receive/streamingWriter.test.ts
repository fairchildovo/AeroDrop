import test from 'node:test';
import assert from 'node:assert/strict';

import { createReceiveStreamingWriter, type ReceiveStreamingTarget } from './streamingWriter.ts';

const createMemoryTarget = (events: string[]): ReceiveStreamingTarget => ({
  kind: 'native-fs',
  write: async (chunk) => {
    events.push(`write:${chunk.byteLength}`);
  },
  close: async () => {
    events.push('close');
  },
  truncate: async (size) => {
    events.push(`truncate:${size}`);
  },
});

test('flushes buffered chunks once the threshold is reached', async () => {
  const events: string[] = [];
  const writer = createReceiveStreamingWriter({
    flushThresholdBytes: 4,
  });

  writer.attachTarget(createMemoryTarget(events));

  await writer.enqueueChunk(new Uint8Array([1, 2]));
  assert.equal(writer.getCommittedBytes(), 0);

  await writer.enqueueChunk(new Uint8Array([3, 4]));
  await writer.awaitIdle();

  assert.deepEqual(events, ['write:4']);
  assert.equal(writer.getCommittedBytes(), 4);
});

test('finalize flushes pending data before closing the target', async () => {
  const events: string[] = [];
  const writer = createReceiveStreamingWriter({
    flushThresholdBytes: 64,
  });

  writer.attachTarget(createMemoryTarget(events));

  await writer.enqueueChunk(new Uint8Array([1, 2, 3]));
  await writer.finalize();

  assert.deepEqual(events, ['write:3', 'close']);
  assert.equal(writer.isStreaming(), false);
});

test('reopenForResume preserves committed bytes for the next native writer', async () => {
  const events: string[] = [];
  const writer = createReceiveStreamingWriter({
    flushThresholdBytes: 64,
  });

  writer.attachTarget(createMemoryTarget(events));
  await writer.enqueueChunk(new Uint8Array([1, 2, 3, 4]));
  await writer.flushPending();
  await writer.closeCurrentTarget();

  assert.equal(writer.getCommittedBytes(), 4);

  let reopenedOffset = -1;
  const reopened = await writer.reopenForResume(async (byteOffset) => {
    reopenedOffset = byteOffset;
    return createMemoryTarget(events);
  }, 4);

  assert.equal(reopened, true);
  assert.equal(reopenedOffset, 4);
  assert.equal(writer.isStreaming(), true);
});

test('native finalize can recover when close throws but file size already matches', async () => {
  const writer = createReceiveStreamingWriter({
    flushThresholdBytes: 64,
  });

  writer.attachTarget({
    kind: 'native-fs',
    write: async () => {},
    close: async () => {
      throw new Error('BENIGN_CLOSE_FAILURE');
    },
    verifyCommittedBytes: async (expectedBytes) => expectedBytes === 5,
  });

  await writer.enqueueChunk(new Uint8Array([1, 2, 3, 4, 5]));
  const finalized = await writer.finalize();

  assert.equal(finalized, true);
  assert.equal(writer.isStreaming(), false);
});

test('closeCurrentTarget keeps native data intact by default', async () => {
  const events: string[] = [];
  const writer = createReceiveStreamingWriter({
    flushThresholdBytes: 64,
  });

  writer.attachTarget({
    kind: 'native-fs',
    write: async () => {},
    close: async () => {
      events.push('close');
    },
    truncate: async (size) => {
      events.push(`truncate:${size}`);
    },
  });

  const closed = await writer.closeCurrentTarget({
    preserveCommittedBytes: true,
  });

  assert.equal(closed, true);
  assert.deepEqual(events, ['close']);
});

test('counts an in-flight batch against the pending byte limit', async () => {
  let releaseWrite!: () => void;
  const blockedWrite = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const writer = createReceiveStreamingWriter({
    flushThresholdBytes: 4,
    maxPendingBytes: 4,
  });

  writer.attachTarget({
    kind: 'native-fs',
    write: () => blockedWrite,
    close: async () => {},
  });

  const pendingWrite = writer.enqueueChunk(new Uint8Array(4));
  await Promise.resolve();
  assert.equal(writer.getBufferedBytes(), 4);

  releaseWrite();
  await pendingWrite;
  assert.equal(writer.getBufferedBytes(), 0);
  assert.equal(writer.getCommittedBytes(), 4);
});

test('rejects a single chunk larger than the pending byte limit', async () => {
  const writer = createReceiveStreamingWriter({
    flushThresholdBytes: 4,
    maxPendingBytes: 4,
  });
  writer.attachTarget(createMemoryTarget([]));

  await assert.rejects(
    writer.enqueueChunk(new Uint8Array(5)),
    /STREAMING_CHUNK_EXCEEDS_PENDING_LIMIT/
  );
});
