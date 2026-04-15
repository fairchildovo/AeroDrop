import { pickPreferredRouteKind, type RouteSnapshot } from '../routeSelectionPolicy';
import type { RouteAttemptKind } from '../../types';

type RouteArbiterOptions = {
  receiverSessionId?: string;
  p2pGraceWindowMs: number;
  onCommit: (kind: RouteAttemptKind) => void;
  now?: () => number;
  schedule?: (ms: number, fn: () => void) => number;
  clearScheduled?: (id: number) => void;
};

export const createReceiveRouteArbiter = (options: RouteArbiterOptions) => {
  let committed = false;
  let provisionalTimer: number | null = null;
  let opened = new Map<RouteAttemptKind, RouteSnapshot>();

  const commit = (kind: RouteAttemptKind) => {
    if (committed) return;
    committed = true;
    if (provisionalTimer !== null) {
      options.clearScheduled?.(provisionalTimer);
      provisionalTimer = null;
    }
    options.onCommit(kind);
  };

  return {
    markAttemptOpen(kind: RouteAttemptKind, snapshot?: Partial<RouteSnapshot>) {
      const route: RouteSnapshot = {
        kind,
        isDirect: snapshot?.isDirect ?? (kind === 'all'),
        isLanDirect: snapshot?.isLanDirect ?? false,
      };
      opened.set(kind, route);

      if (kind === 'all') {
        const relay = opened.get('relay');
        if (!relay) {
          commit('all');
          return;
        }

        const preferred = pickPreferredRouteKind(relay, route);
        if (preferred === 'all') {
          commit('all');
        }
        return;
      }

      if (opened.has('all')) {
        const all = opened.get('all')!;
        const preferred = pickPreferredRouteKind(route, all);
        commit(preferred);
        return;
      }

      provisionalTimer = options.schedule?.(options.p2pGraceWindowMs, () => commit('relay')) ?? null;
    },
  };
};
