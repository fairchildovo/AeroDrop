import { TransferState } from '../../types';

export const shouldAutoResumeCommittedReconnect = (options: {
  pendingReconnectResume: boolean;
  isResumable: boolean;
}) => options.pendingReconnectResume && options.isResumable;

export const shouldPreserveCommittedReconnectResumeIntent = (options: {
  currentState: TransferState;
  transferActive: boolean;
}) => options.currentState === TransferState.TRANSFERRING && options.transferActive;
