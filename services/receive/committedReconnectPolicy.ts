import { TransferState } from '../../types/index.ts';

export const shouldAutoReconnectCommittedSession = (options: {
  currentState: TransferState;
  hasCode: boolean;
  intentionalClose: boolean;
}) =>
  options.hasCode &&
  !options.intentionalClose &&
  (options.currentState === TransferState.PEER_CONNECTED ||
    options.currentState === TransferState.TRANSFERRING);

export const getCommittedSessionReconnectDelayMs = (attempt: number) =>
  Math.min(600 * Math.max(1, attempt), 3000);
