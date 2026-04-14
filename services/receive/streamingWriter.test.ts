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
