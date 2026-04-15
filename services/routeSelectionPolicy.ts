import type { RouteAttemptKind } from '../types';

export type RouteSelectionContext = {
  isMobileDevice: boolean;
  isConstrained: boolean;
  relayRecommended: boolean;
  fetchLatencyMs?: number | null;
};

export type RouteSnapshot = {
  kind: RouteAttemptKind;
  isDirect: boolean;
  isLanDirect: boolean;
};

export const getRouteSelectionTimings = (context: RouteSelectionContext) => {
  if (context.isMobileDevice || context.isConstrained) {
    return { startAllImmediately: true, startRelayDelayMs: 500, p2pGraceWindowMs: 900 };
  }

  if (
    context.relayRecommended ||
    (typeof context.fetchLatencyMs === 'number' && context.fetchLatencyMs >= 1200)
  ) {
    return { startAllImmediately: true, startRelayDelayMs: 800, p2pGraceWindowMs: 1500 };
  }

  return { startAllImmediately: true, startRelayDelayMs: null, p2pGraceWindowMs: 1800 };
};

export const pickPreferredRouteKind = (
  left: RouteSnapshot,
  right: RouteSnapshot
): RouteAttemptKind => {
  const rank = (route: RouteSnapshot) => {
    if (route.isLanDirect) return 3;
    if (route.isDirect) return 2;
    return 1;
  };

  return rank(right) > rank(left) ? right.kind : left.kind;
};
