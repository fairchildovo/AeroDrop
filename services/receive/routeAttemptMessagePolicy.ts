import type { P2PMessage } from '../../types';

export type RouteAttemptTransferControlMessageType =
  | 'DEVICE_INFO'
  | 'METADATA'
  | 'REJECT_TRANSFER'
  | 'TRANSFER_CANCELLED';

export const isRouteAttemptTransferControlMessage = (
  type: P2PMessage['type']
): type is RouteAttemptTransferControlMessageType =>
  type === 'DEVICE_INFO' ||
  type === 'METADATA' ||
  type === 'REJECT_TRANSFER' ||
  type === 'TRANSFER_CANCELLED';

export const getNonWinningRouteMessageDisposition = (options: {
  winnerCommitted: boolean;
  messageType: RouteAttemptTransferControlMessageType;
}) => {
  if (!options.winnerCommitted) {
    return 'buffer' as const;
  }

  return 'reject' as const;
};
