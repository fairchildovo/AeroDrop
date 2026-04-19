import { TransferState, type NormalizedFileRequest } from '../../types/index.ts';
import { createResumeRequestMessage, normalizeFileRequest } from '../protocol.ts';
import { logDebug } from '../diagnostics.ts';

interface SendableConnection {
  open: boolean;
  send: (message: unknown) => void;
}

export interface ReceiveRecoveryCoordinatorOptions {
  maxAutoRepairRetries: number;
  getConnection: () => SendableConnection | null;
  setTransferActive: (active: boolean) => void;
  getCurrentFileIndex: () => number;
  getReceivedSize: () => number;
  getCommittedStreamBytes?: () => number;
  isFileCompleted: (fileIndex: number) => boolean;
  hasRetainedCurrentFileData: (fileIndex: number) => boolean;
  flushPendingStreamWrites: () => Promise<boolean>;
  reopenNativeWriterForResume: (fileIndex: number, byteOffset: number) => Promise<boolean>;
  resetFileBuffersForRepair: (fileIndex: number) => void;
  resetHasherForRepair: () => Promise<boolean>;
  abortStreams: () => Promise<void>;
  awaitWriteQueue: () => Promise<void>;
  deleteIndexedDbChunksForFile: (fileIndex: number) => Promise<void>;
  setProgress: (value: number) => void;
  setDownloadSpeed: (value: string) => void;
  setDownloadSpeedBytes: (value: number) => void;
  setEta: (value: string) => void;
  setTransferState: (state: TransferState) => void;
  setError: (message: string) => void;
  notify?: (message: string, type: 'success' | 'info' | 'error') => void;
  failTransferPersistence: (message: string) => void;
}

export interface ReceiveRecoveryCoordinator {
  requestAutoRepair: (fileIndex: number, reason: string) => Promise<boolean>;
  resumeTransfer: () => Promise<void>;
  getPendingAutoRepairFile: () => number | null;
  hasPendingAutoRepair: () => boolean;
  clearPendingAutoRepairFile: (fileIndex?: number) => void;
  clearRepairStateForFile: (fileIndex: number) => void;
  reset: () => void;
}

const buildResumeRequest = (request: NormalizedFileRequest) =>
  createResumeRequestMessage(normalizeFileRequest(request));

export const createReceiveRecoveryCoordinator = (
  options: ReceiveRecoveryCoordinatorOptions
): ReceiveRecoveryCoordinator => {
  const repairAttempts = new Map<number, number>();
  let pendingAutoRepairFile: number | null = null;

  const getPendingAutoRepairFile = () => pendingAutoRepairFile;

  const clearPendingAutoRepairFile = (fileIndex?: number) => {
    if (typeof fileIndex === 'number' && pendingAutoRepairFile !== fileIndex) {
      return;
    }
    pendingAutoRepairFile = null;
  };

  const clearRepairStateForFile = (fileIndex: number) => {
    repairAttempts.delete(fileIndex);
    clearPendingAutoRepairFile(fileIndex);
  };

  const sendResumeRequest = (request: NormalizedFileRequest): boolean => {
    const conn = options.getConnection();
    if (!conn || !conn.open) {
      return false;
    }

    conn.send(buildResumeRequest(request));
    return true;
  };

  const requestAutoRepair = async (fileIndex: number, reason: string): Promise<boolean> => {
    const attempt = (repairAttempts.get(fileIndex) || 0) + 1;
    repairAttempts.set(fileIndex, attempt);

    if (attempt > options.maxAutoRepairRetries) {
      options.failTransferPersistence(`文件自动修复失败（已重试 ${options.maxAutoRepairRetries} 次）：${reason}`);
      return false;
    }

    pendingAutoRepairFile = fileIndex;
    options.setProgress(0);
    options.setDownloadSpeed('0 KB/s');
    options.setDownloadSpeedBytes(0);
    options.setEta('自动修复中...');

    options.resetFileBuffersForRepair(fileIndex);
    const hasherReady = await options.resetHasherForRepair();
    if (!hasherReady) {
      options.failTransferPersistence('文件校验初始化失败，请重试传输。');
      return false;
    }

    await options.abortStreams();
    try {
      await options.awaitWriteQueue();
      await options.deleteIndexedDbChunksForFile(fileIndex);
    } catch (error) {
      logDebug('warn', 'IndexedDB cleanup before repair failed:', error);
    }

    try {
      const sent = sendResumeRequest({
        fileIndex,
        byteOffset: 0,
        silent: true,
      });
      if (!sent) {
        options.failTransferPersistence('连接已断开，无法自动修复，请重试。');
        return false;
      }
    } catch {
      options.failTransferPersistence('自动修复请求发送失败，请重试。');
      return false;
    }

    return true;
  };

  const resumeTransfer = async (): Promise<void> => {
    const conn = options.getConnection();
    if (!conn || !conn.open) {
      options.setError('连接已断开，请重新连接发送方。');
      options.setTransferState(TransferState.ERROR);
      if (options.notify) {
        options.notify('连接已断开，请重试', 'error');
      }
      return;
    }

    options.setTransferActive(true);
    const currentIdx = options.getCurrentFileIndex();

    if (options.isFileCompleted(currentIdx)) {
      conn.send(buildResumeRequest({
        fileIndex: currentIdx + 1,
        byteOffset: 0,
      }));
      options.setTransferState(TransferState.TRANSFERRING);
      return;
    }

    let byteOffset = 0;
    let canResumeCurrentFile = false;
    const receivedSize = Math.max(0, options.getReceivedSize());

    if (options.hasRetainedCurrentFileData(currentIdx)) {
      const flushed = await options.flushPendingStreamWrites();
      if (!flushed) {
        return;
      }
      byteOffset = receivedSize;
      canResumeCurrentFile = byteOffset > 0;
    } else if (receivedSize > 0) {
      const durableOffset = typeof options.getCommittedStreamBytes === 'function'
        ? Math.max(0, Math.min(receivedSize, options.getCommittedStreamBytes()))
        : receivedSize;
      const reopened = await options.reopenNativeWriterForResume(currentIdx, durableOffset);
      if (reopened) {
        byteOffset = durableOffset;
        canResumeCurrentFile = byteOffset > 0;
      }
    }

    if (!canResumeCurrentFile && receivedSize > 0 && options.notify) {
      options.notify('当前文件的流式落盘状态无法直接续写，本次将从该文件开头重新下载。', 'info');
    }

    conn.send(buildResumeRequest({
      fileIndex: currentIdx,
      byteOffset: canResumeCurrentFile ? byteOffset : 0,
    }));
    options.setTransferState(TransferState.TRANSFERRING);
  };

  return {
    requestAutoRepair,
    resumeTransfer,
    getPendingAutoRepairFile,
    hasPendingAutoRepair: () => pendingAutoRepairFile !== null,
    clearPendingAutoRepairFile,
    clearRepairStateForFile,
    reset: () => {
      repairAttempts.clear();
      pendingAutoRepairFile = null;
    },
  };
};
