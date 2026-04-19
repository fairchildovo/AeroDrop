import test from 'node:test';
import assert from 'node:assert/strict';

import { createSerialAsyncProcessor } from './serialAsyncProcessor.ts';

test('runs async tasks strictly in submission order', async () => {
  const processor = createSerialAsyncProcessor();
  const events: string[] = [];

  const first = processor.enqueue(async () => {
    events.push('first:start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    events.push('first:end');
  });

  const second = processor.enqueue(async () => {
    events.push('second:start');
    events.push('second:end');
  });

  await Promise.all([first, second]);

  assert.deepEqual(events, [
    'first:start',
    'first:end',
    'second:start',
    'second:end',
  ]);
});

test('continues processing later tasks after a failure', async () => {
  const processor = createSerialAsyncProcessor();
  const events: string[] = [];

  await assert.rejects(
    processor.enqueue(async () => {
      events.push('first');
      throw new Error('EXPECTED_FAILURE');
    }),
    /EXPECTED_FAILURE/
  );

  await processor.enqueue(async () => {
    events.push('second');
  });

  assert.deepEqual(events, ['first', 'second']);
});
