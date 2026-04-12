import type { SenderSessionSnapshot } from '../types';

export interface SenderSessionService {
  startShare: () => Promise<void>;
  stopShare: () => void;
  copyShareCode: () => Promise<void>;
  copyShareLink: () => Promise<void>;
  getSenderSessionSnapshot: () => SenderSessionSnapshot;
}

export const createSenderSessionService = (service: SenderSessionService): SenderSessionService => service;
