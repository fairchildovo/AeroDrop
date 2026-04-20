import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppNotification } from '../types';
import { shouldEnqueueNotification } from './notificationPolicy.ts';

test('blocks duplicate notifications with the same message and type inside the dedupe window', () => {
  const now = 10_000;
  const existing: AppNotification[] = [
    {
      id: 'a',
      message: '连接中断，正在尝试恢复...',
      type: 'info',
      timestamp: now - 500,
    },
  ];

  assert.equal(
    shouldEnqueueNotification(existing, {
      message: '连接中断，正在尝试恢复...',
      type: 'info',
      now,
      dedupeWindowMs: 1_500,
    }),
    false
  );
});

test('allows the same message again after the dedupe window expires', () => {
  const now = 10_000;
  const existing: AppNotification[] = [
    {
      id: 'a',
      message: '连接中断，正在尝试恢复...',
      type: 'info',
      timestamp: now - 5_000,
    },
  ];

  assert.equal(
    shouldEnqueueNotification(existing, {
      message: '连接中断，正在尝试恢复...',
      type: 'info',
      now,
      dedupeWindowMs: 1_500,
    }),
    true
  );
});
