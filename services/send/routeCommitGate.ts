export type RouteCommitClaim =
  | { status: 'claimed' }
  | { status: 'duplicate' }
  | { status: 'conflict' };

export const createRouteCommitGate = () => {
  const committed = new Map<string, string>();

  return {
    claimCommit(receiverSessionId: string, connectionId: string): RouteCommitClaim {
      const existing = committed.get(receiverSessionId);
      if (!existing) {
        committed.set(receiverSessionId, connectionId);
        return { status: 'claimed' };
      }

      if (existing === connectionId) {
        return { status: 'duplicate' };
      }

      return { status: 'conflict' };
    },
    markCommitted(receiverSessionId: string, connectionId: string) {
      committed.set(receiverSessionId, connectionId);
    },
    canSendMetadata(receiverSessionId: string) {
      return committed.has(receiverSessionId);
    },
    getCommittedConnectionId(receiverSessionId: string) {
      return committed.get(receiverSessionId) ?? null;
    },
    releaseConnection(connectionId: string) {
      for (const [receiverSessionId, committedConnectionId] of committed) {
        if (committedConnectionId === connectionId) {
          committed.delete(receiverSessionId);
        }
      }
    },
  };
};
