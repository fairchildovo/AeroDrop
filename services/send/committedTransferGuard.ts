import type { P2PMessage } from '../../types';
import type { createRouteCommitGate } from './routeCommitGate';

export type CommittedTransferMessageType =
  | 'ACCEPT_TRANSFER'
  | 'FILE_REQUEST'
  | 'TRANSFER_CANCELLED'
  | 'TRANSFER_PROGRESS'
  | 'ALL_FILES_RECEIVED'
  | 'HEARTBEAT';

export const isCommittedTransferMessageType = (
  type: P2PMessage['type']
): type is CommittedTransferMessageType =>
  type === 'ACCEPT_TRANSFER' ||
  type === 'FILE_REQUEST' ||
  type === 'TRANSFER_CANCELLED' ||
  type === 'TRANSFER_PROGRESS' ||
  type === 'ALL_FILES_RECEIVED' ||
  type === 'HEARTBEAT';

export const getCommittedTransferDisposition = (options: {
  connectionId: string | null;
  peerId: string;
  peerSessionIds: Map<string, string>;
  commitGate: ReturnType<typeof createRouteCommitGate>;
}) => {
  if (!options.connectionId) {
    return 'reject' as const;
  }

  const receiverSessionId = options.peerSessionIds.get(options.peerId);
  if (!receiverSessionId) {
    return 'reject' as const;
  }

  return options.commitGate.getCommittedConnectionId(receiverSessionId) === options.connectionId
    ? 'allow'
    : 'reject';
};
