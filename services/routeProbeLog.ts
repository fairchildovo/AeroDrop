import type { RouteAttemptKind } from '../types';

export type RouteProbeLogPayload = {
  receiverSessionId: string;
  attemptId: string;
  attemptKind: RouteAttemptKind;
  openedAt: number;
  peerId?: string;
};

export const createRouteProbeLogPayload = (payload: RouteProbeLogPayload) => payload;
