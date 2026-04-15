import type { ConnectionTypeLabel } from '../../types';

export type LogicalReceiverState = {
  peerProgress?: number;
  peerRealtimeSpeed?: number;
  peerAverageSpeed?: number;
  peerTransferredBytes?: number;
  peerTotalBytes?: number;
  peerSyncStartAt?: number;
  peerSyncBaseBytes?: number;
  peerTransferEpoch?: number;
  peerConnectionType?: ConnectionTypeLabel;
  peerIsLAN?: boolean;
  peerName?: string;
  hasProgressSync: boolean;
  awaitingFinalizeAck: boolean;
  pendingSend: boolean;
  activeSending: boolean;
};

type StateMaps = {
  peerProgress: Map<string, number>;
  peerRealtimeSpeed: Map<string, number>;
  peerAverageSpeed: Map<string, number>;
  peerTransferredBytes: Map<string, number>;
  peerTotalBytes: Map<string, number>;
  peerSyncStartAt: Map<string, number>;
  peerSyncBaseBytes: Map<string, number>;
  peerTransferEpoch: Map<string, number>;
  peerConnectionType: Map<string, ConnectionTypeLabel>;
  peerIsLAN: Map<string, boolean>;
  peerNames: Record<string, string>;
  peerHasProgressSync: Set<string>;
  peerAwaitingFinalizeAck: Set<string>;
  pendingSendPeers: Set<string>;
  activeSendingPeers: Set<string>;
};

export const captureLogicalReceiverState = (
  peerId: string,
  state: StateMaps
): LogicalReceiverState | null => {
  const snapshot: LogicalReceiverState = {
    peerProgress: state.peerProgress.get(peerId),
    peerRealtimeSpeed: state.peerRealtimeSpeed.get(peerId),
    peerAverageSpeed: state.peerAverageSpeed.get(peerId),
    peerTransferredBytes: state.peerTransferredBytes.get(peerId),
    peerTotalBytes: state.peerTotalBytes.get(peerId),
    peerSyncStartAt: state.peerSyncStartAt.get(peerId),
    peerSyncBaseBytes: state.peerSyncBaseBytes.get(peerId),
    peerTransferEpoch: state.peerTransferEpoch.get(peerId),
    peerConnectionType: state.peerConnectionType.get(peerId),
    peerIsLAN: state.peerIsLAN.get(peerId),
    peerName: state.peerNames[peerId],
    hasProgressSync: state.peerHasProgressSync.has(peerId),
    awaitingFinalizeAck: state.peerAwaitingFinalizeAck.has(peerId),
    pendingSend: state.pendingSendPeers.has(peerId),
    activeSending: state.activeSendingPeers.has(peerId),
  };

  const hasValue = Object.values(snapshot).some((value) => value !== undefined && value !== false);
  return hasValue ? snapshot : null;
};

export const restoreLogicalReceiverState = (
  snapshot: LogicalReceiverState,
  peerId: string,
  state: StateMaps
) => {
  const restoreMapValue = <T,>(map: Map<string, T>, value: T | undefined) => {
    if (value !== undefined) {
      map.set(peerId, value);
    }
  };

  restoreMapValue(state.peerProgress, snapshot.peerProgress);
  restoreMapValue(state.peerRealtimeSpeed, snapshot.peerRealtimeSpeed);
  restoreMapValue(state.peerAverageSpeed, snapshot.peerAverageSpeed);
  restoreMapValue(state.peerTransferredBytes, snapshot.peerTransferredBytes);
  restoreMapValue(state.peerTotalBytes, snapshot.peerTotalBytes);
  restoreMapValue(state.peerSyncStartAt, snapshot.peerSyncStartAt);
  restoreMapValue(state.peerSyncBaseBytes, snapshot.peerSyncBaseBytes);
  restoreMapValue(state.peerTransferEpoch, snapshot.peerTransferEpoch);
  restoreMapValue(state.peerConnectionType, snapshot.peerConnectionType);
  restoreMapValue(state.peerIsLAN, snapshot.peerIsLAN);

  if (snapshot.peerName) {
    state.peerNames[peerId] = snapshot.peerName;
  }
  if (snapshot.hasProgressSync) {
    state.peerHasProgressSync.add(peerId);
  }
  if (snapshot.awaitingFinalizeAck) {
    state.peerAwaitingFinalizeAck.add(peerId);
  }
  if (snapshot.pendingSend) {
    state.pendingSendPeers.add(peerId);
  }
  if (snapshot.activeSending) {
    state.activeSendingPeers.add(peerId);
  }
};
