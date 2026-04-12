import { create } from 'zustand';
import {
  TransferState,
  type ReceiverSessionSnapshot,
  type SenderSessionSnapshot,
} from '../types';

export interface TransferStoreState {
  sender: SenderSessionSnapshot;
  receiver: ReceiverSessionSnapshot;
  setSenderSnapshot: (partial: Partial<SenderSessionSnapshot>) => void;
  setReceiverSnapshot: (partial: Partial<ReceiverSessionSnapshot>) => void;
  resetSenderSnapshot: () => void;
  resetReceiverSnapshot: () => void;
}

const createDefaultSenderSnapshot = (): SenderSessionSnapshot => ({
  state: TransferState.IDLE,
  errorMsg: '',
  transferCode: '',
  shareLink: '',
  connectionStatus: '',
  remainingTime: '',
  totalProgress: 0,
  currentFileIndex: 0,
  currentSpeed: '0 KB/s',
  avgSpeed: '0 KB/s',
  currentSpeedBytes: 0,
  avgSpeedBytes: 0,
  activeTransfersCount: 0,
  activeConnectionsCount: 0,
  totalBytes: 0,
  transferredBytes: 0,
  overallEta: '--',
  metadata: null,
  peers: [],
});

const createDefaultReceiverSnapshot = (): ReceiverSessionSnapshot => ({
  state: TransferState.IDLE,
  errorMsg: '',
  code: '',
  connectingStage: '',
  metadata: null,
  senderDeviceName: '',
  canResume: false,
  isStreaming: false,
  progress: 0,
  downloadSpeed: '0 KB/s',
  downloadSpeedBytes: 0,
  eta: '--',
  overallTransferredBytes: 0,
  totalBytes: 0,
  overallEta: '--',
  currentFileIndex: 0,
  totalFiles: 0,
  currentFileName: '',
});

export const useTransferStore = create<TransferStoreState>((set) => ({
  sender: createDefaultSenderSnapshot(),
  receiver: createDefaultReceiverSnapshot(),
  setSenderSnapshot: (partial) =>
    set((state) => ({
      sender: { ...state.sender, ...partial },
    })),
  setReceiverSnapshot: (partial) =>
    set((state) => ({
      receiver: { ...state.receiver, ...partial },
    })),
  resetSenderSnapshot: () => set({ sender: createDefaultSenderSnapshot() }),
  resetReceiverSnapshot: () => set({ receiver: createDefaultReceiverSnapshot() }),
}));
