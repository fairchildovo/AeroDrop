import type { RouteAttemptKind } from '../../types';

export type RegisterAttemptInput = {
  receiverSessionId: string;
  attemptId: string;
  attemptKind: RouteAttemptKind;
  peerId: string;
  connectionId: string;
};

export type ReceiverSessionRecord = {
  receiverSessionId: string;
  attempts: Partial<Record<RouteAttemptKind, RegisterAttemptInput>>;
  committedConnectionId?: string;
  reconnectCandidateConnectionIds?: Set<string>;
};

export const createReceiverSessionRegistry = () => {
  const sessions = new Map<string, ReceiverSessionRecord>();

  const getOrCreateSession = (receiverSessionId: string): ReceiverSessionRecord => {
    const existing = sessions.get(receiverSessionId);
    if (existing) {
      return existing;
    }

      const created: ReceiverSessionRecord = {
        receiverSessionId,
        attempts: {},
        reconnectCandidateConnectionIds: new Set<string>(),
      };
      sessions.set(receiverSessionId, created);
      return created;
  };

  const deleteSessionIfEmpty = (receiverSessionId: string) => {
    const session = sessions.get(receiverSessionId);
    if (!session) return;

    const hasAttempts = Object.keys(session.attempts).length > 0;
    if (!hasAttempts && !session.committedConnectionId) {
      sessions.delete(receiverSessionId);
    }
  };

  return {
    registerAttempt(input: RegisterAttemptInput) {
      const session = getOrCreateSession(input.receiverSessionId);
      if (
        session.committedConnectionId &&
        session.committedConnectionId !== input.connectionId
      ) {
        session.reconnectCandidateConnectionIds?.add(input.connectionId);
      }
      session.attempts[input.attemptKind] = input;
      return session;
    },
    resolveAttemptForCommit(receiverSessionId: string, attemptId: string, connectionId: string) {
      const session = sessions.get(receiverSessionId);
      if (!session) {
        return false;
      }

      return Object.values(session.attempts).some(
        (attempt) => attempt?.attemptId === attemptId && attempt.connectionId === connectionId
      );
    },
    markCommitted(receiverSessionId: string, connectionId: string) {
      const session = getOrCreateSession(receiverSessionId);
      session.committedConnectionId = connectionId;
      session.reconnectCandidateConnectionIds?.clear();
    },
    isReconnectCandidate(receiverSessionId: string, connectionId: string) {
      const session = sessions.get(receiverSessionId);
      if (!session) {
        return false;
      }

      return session.reconnectCandidateConnectionIds?.has(connectionId) ?? false;
    },
    getSession(receiverSessionId: string) {
      return sessions.get(receiverSessionId);
    },
    releaseConnection(connectionId: string) {
      for (const [receiverSessionId, session] of sessions) {
        if (session.committedConnectionId === connectionId) {
          delete session.committedConnectionId;
        }

        for (const [attemptKind, attempt] of Object.entries(session.attempts)) {
          if (attempt?.connectionId === connectionId) {
            delete session.attempts[attemptKind as RouteAttemptKind];
          }
        }

        session.reconnectCandidateConnectionIds?.delete(connectionId);

        deleteSessionIfEmpty(receiverSessionId);
      }
    },
  };
};
