import type { FileMetadata, P2PMessage } from '../../types';
import type { createReceiverSessionRegistry } from './receiverSessionRegistry';
import type { createRouteCommitGate } from './routeCommitGate';

export type SenderRouteHandshakeConnection = {
  peer: string;
  send: (message: P2PMessage) => void;
  close: () => void;
};

type SenderRouteHandshakeOptions = {
  registry: ReturnType<typeof createReceiverSessionRegistry>;
  commitGate: ReturnType<typeof createRouteCommitGate>;
  metadata: FileMetadata;
  deviceName: string;
  onRouteCommitted?: (args: {
    conn: SenderRouteHandshakeConnection;
    receiverSessionId: string;
    selectedKind: 'all' | 'relay';
  }) => void;
};

export const createSenderRouteHandshakeHandler = <TConn extends SenderRouteHandshakeConnection>(
  options: SenderRouteHandshakeOptions & {
    getConnectionId: (conn: TConn) => string;
    onRouteCommitted?: (args: {
      conn: TConn;
      receiverSessionId: string;
      selectedKind: 'all' | 'relay';
    }) => void;
  }
) => ({
  handleMessage(conn: TConn, msg: P2PMessage) {
    if (msg.type === 'ROUTE_PROBE') {
      options.registry.registerAttempt({
        receiverSessionId: msg.payload.receiverSessionId,
        attemptId: msg.payload.attemptId,
        attemptKind: msg.payload.attemptKind,
        peerId: conn.peer,
        connectionId: options.getConnectionId(conn),
      });

      conn.send({
        type: 'ROUTE_READY',
        payload: {
          receiverSessionId: msg.payload.receiverSessionId,
          attemptId: msg.payload.attemptId,
        },
      });
      return true;
    }

    if (msg.type === 'ROUTE_COMMIT') {
      const connectionId = options.getConnectionId(conn);
      if (
        !options.registry.resolveAttemptForCommit(
          msg.payload.receiverSessionId,
          msg.payload.attemptId,
          connectionId
        )
      ) {
        conn.close();
        return true;
      }

      const commitClaim = options.commitGate.claimCommit(msg.payload.receiverSessionId, connectionId);
      if (commitClaim.status === 'conflict') {
        conn.close();
        return true;
      }
      if (commitClaim.status === 'duplicate') {
        return true;
      }

      options.registry.markCommitted(msg.payload.receiverSessionId, connectionId);

      try {
        conn.send({
          type: 'DEVICE_INFO',
          payload: { deviceName: options.deviceName },
        });
        conn.send({ type: 'METADATA', payload: options.metadata });
        options.onRouteCommitted?.({
          conn,
          receiverSessionId: msg.payload.receiverSessionId,
          selectedKind: msg.payload.selectedKind,
        });
      } catch (error) {
        console.error('Failed to send committed route metadata', error);
      }
      return true;
    }

    if (msg.type === 'ROUTE_ABORT') {
      conn.close();
      return true;
    }

    return false;
  },
});
