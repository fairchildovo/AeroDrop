import { pickPreferredRouteKind, type RouteSnapshot } from '../routeSelectionPolicy.ts';
import type { RouteAttemptKind } from '../../types/index.ts';

type ReadyRouteAttempt = RouteSnapshot & {
  attemptId: string;
};

type RouteArbiterOptions = {
  receiverSessionId?: string;
  p2pGraceWindowMs: number;
  onCommit: (winner: { kind: RouteAttemptKind; attemptId: string }) => void;
  now?: () => number;
  schedule?: (ms: number, fn: () => void) => number;
  clearScheduled?: (id: number) => void;
};

export const createReceiveRouteArbiter = (options: RouteArbiterOptions) => {
  let committed = false;
  let provisionalTimer: number | null = null;
  let readyAttempts = new Map<RouteAttemptKind, ReadyRouteAttempt>();

  const commit = (attempt: ReadyRouteAttempt) => {
    if (committed) return;
    committed = true;
    if (provisionalTimer !== null) {
      options.clearScheduled?.(provisionalTimer);
      provisionalTimer = null;
    }
    options.onCommit({ kind: attempt.kind, attemptId: attempt.attemptId });
  };

  return {
    markAttemptReady(attemptId: string, kind: RouteAttemptKind, snapshot?: Partial<RouteSnapshot>) {
      const route: ReadyRouteAttempt = {
        attemptId,
        kind,
        isDirect: snapshot?.isDirect ?? (kind === 'all'),
        isLanDirect: snapshot?.isLanDirect ?? false,
      };
      readyAttempts.set(kind, route);

      if (kind === 'all') {
        const relay = readyAttempts.get('relay');
        if (!relay) {
          commit(route);
          return;
        }

        const preferred = pickPreferredRouteKind(relay, route);
        if (preferred === 'all') {
          commit(route);
        }
        return;
      }

      if (provisionalTimer !== null) {
        options.clearScheduled?.(provisionalTimer);
        provisionalTimer = null;
      }

      if (readyAttempts.has('all')) {
        const all = readyAttempts.get('all')!;
        const preferred = pickPreferredRouteKind(route, all);
        commit(preferred === 'all' ? all : route);
        return;
      }

      provisionalTimer = options.schedule?.(options.p2pGraceWindowMs, () => commit(route)) ?? null;
    },
  };
};
