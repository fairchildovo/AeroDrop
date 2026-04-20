import type { AppNotification } from '../types';

export interface NotificationPolicyInput {
  message: string;
  type: AppNotification['type'];
  now: number;
  dedupeWindowMs: number;
}

export const shouldEnqueueNotification = (
  notifications: AppNotification[],
  input: NotificationPolicyInput
): boolean => {
  return !notifications.some(
    (notification) =>
      notification.message === input.message &&
      notification.type === input.type &&
      input.now - notification.timestamp < input.dedupeWindowMs
  );
};
