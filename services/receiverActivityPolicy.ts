import { TransferState } from '../types';

export interface ReceiverActivityInput {
  activityToken: number;
  currentActivityToken: number;
}

export interface ReceiverScheduledReconnectInput extends ReceiverActivityInput {
  state: TransferState;
  hasPeer: boolean;
  peerDestroyed: boolean;
}

export const shouldHandleReceiverActivity = (input: ReceiverActivityInput): boolean => {
  return input.activityToken === input.currentActivityToken;
};

export const shouldRunReceiverScheduledReconnect = (
  input: ReceiverScheduledReconnectInput
): boolean => {
  return (
    shouldHandleReceiverActivity(input) &&
    input.state === TransferState.WAITING_FOR_PEER &&
    input.hasPeer &&
    !input.peerDestroyed
  );
};
