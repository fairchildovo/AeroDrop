import { TransferState } from '../../types';

interface FinalizeBatch<T> {
  batch: T[];
  size: number;
}

export interface ReceivePersistenceOrchestratorOptions {
  getState: () => TransferState;
  isTransferActive: () => boolean;
  getCurrentFileIndex: () => number;
  isIndexedDbBuffering: () => boolean;
  isStreaming: () => boolean;
  takeIndexedDbBatch: () => FinalizeBatch<ArrayBuffer>;
  flushIndexedDbBatch: (fileIndex: number, batch: ArrayBuffer[], totalLen: number) => Promise<void>;
  takeStreamBatch: () => FinalizeBatch<Uint8Array>;
  flushSpecificBatch: (batch: Uint8Array[], totalLen: number) => Promise<void>;
  enqueueWrite: (task: () => Promise<void>) => Promise<void>;
  closeStreams: () => Promise<boolean>;
  saveCurrentFile: () => Promise<boolean>;
  markCurrentFilePersisted: (fileName: string) => void;
  failTransferPersistence: (message: string) => void;
}

export interface ReceivePersistenceOrchestrator {
  awaitPendingFileFinalize: (reason: string) => Promise<boolean>;
  finalizeCurrentFile: (fileName: string) => Promise<void>;
  reset: () => void;
}

export const createReceivePersistenceOrchestrator = (
  options: ReceivePersistenceOrchestratorOptions
): ReceivePersistenceOrchestrator => {
  let pendingFinalizePromise: Promise<void> | null = null;

  const awaitPendingFileFinalize = async (reason: string): Promise<boolean> => {
    if (!pendingFinalizePromise) {
      return true;
    }

    try {
      await pendingFinalizePromise;
    } catch (error) {
      console.warn(`Pending file finalize failed before ${reason}:`, error);
    }

    return options.getState() !== TransferState.ERROR;
  };

  const finalizeCurrentFile = (fileName: string): Promise<void> => {
    const finalizePromise = (async () => {
      if (options.isIndexedDbBuffering()) {
        const indexedDbBatch = options.takeIndexedDbBatch();
        await options.enqueueWrite(async () => {
          if (indexedDbBatch.size > 0) {
            await options.flushIndexedDbBatch(
              options.getCurrentFileIndex(),
              indexedDbBatch.batch,
              indexedDbBatch.size
            );
          }
        });
      }

      const streamBatch = options.takeStreamBatch();
      await options.enqueueWrite(async () => {
        if (streamBatch.size > 0) {
          await options.flushSpecificBatch(streamBatch.batch, streamBatch.size);
        }

        if (options.isStreaming()) {
          const closeOk = await options.closeStreams();
          if (!closeOk) {
            options.failTransferPersistence('文件落盘失败，请重试。');
            return;
          }
        }

        if (!options.isTransferActive() || options.getState() === TransferState.ERROR) {
          return;
        }

        if (options.isIndexedDbBuffering()) {
          const saved = await options.saveCurrentFile();
          if (!saved) {
            return;
          }
        }

        options.markCurrentFilePersisted(fileName);
      });
    })();

    pendingFinalizePromise = finalizePromise.finally(() => {
      if (pendingFinalizePromise === finalizePromise) {
        pendingFinalizePromise = null;
      }
    });

    return pendingFinalizePromise;
  };

  const reset = () => {
    pendingFinalizePromise = null;
  };

  return {
    awaitPendingFileFinalize,
    finalizeCurrentFile,
    reset,
  };
};
