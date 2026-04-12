import type { ReceiverSessionSnapshot } from '../types';

export interface ReceiverSessionService {
  connect: (code: string) => Promise<void>;
  acceptTransfer: () => Promise<void>;
  resumeTransfer: () => void;
  resetReceiverSession: () => void;
  getReceiverSessionSnapshot: () => ReceiverSessionSnapshot;
}

export const createReceiverSessionService = (service: ReceiverSessionService): ReceiverSessionService => service;
