export type ReceiveStreamingTargetKind = 'native-fs' | 'stream-saver';

export interface ReceiveStreamingTarget {
  kind: ReceiveStreamingTargetKind;
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
  truncate?: (size: number) => Promise<void>;
}

export interface ReceiveStreamingWriterOptions {
  flushThresholdBytes: number;
}

export interface ReceiveStreamingWriter {
  attachTarget: (
    target: ReceiveStreamingTarget,
    options?: { committedBytes?: number; resetCommittedBytes?: boolean }
  ) => void;
  enqueueChunk: (chunk: Uint8Array) => Promise<void>;
  flushPending: () => Promise<void>;
  awaitIdle: () => Promise<void>;
  finalize: () => Promise<boolean>;
  closeCurrentTarget: (options?: {
    truncateNativeBeforeClose?: boolean;
    abortStreamSaver?: boolean;
    preserveCommittedBytes?: boolean;
  }) => Promise<boolean>;
  reopenForResume: (
    factory: (byteOffset: number) => Promise<ReceiveStreamingTarget>,
    byteOffset?: number
  ) => Promise<boolean>;
  isStreaming: () => boolean;
  hasRetainedData: () => boolean;
  getCommittedBytes: () => number;
  getBufferedBytes: () => number;
  reset: () => void;
}

export const createReceiveStreamingWriter = (
  options: ReceiveStreamingWriterOptions
): ReceiveStreamingWriter => {
  let activeTarget: ReceiveStreamingTarget | null = null;
  let pendingChunks: Uint8Array[] = [];
  let pendingBytes = 0;
  let committedBytes = 0;
  let writeQueue: Promise<void> = Promise.resolve();
  let failedError: unknown = null;

  const clearPending = () => {
    pendingChunks = [];
    pendingBytes = 0;
  };

  const clearFailure = () => {
    failedError = null;
  };

  const ensureHealthy = () => {
    if (failedError) {
      throw failedError;
    }
    if (!activeTarget) {
      throw new Error('STREAMING_TARGET_UNAVAILABLE');
    }
  };

  const snapshotPending = (): { chunks: Uint8Array[]; totalLen: number } => {
    const chunks = pendingChunks;
    const totalLen = pendingBytes;
    clearPending();
    return { chunks, totalLen };
  };

  const scheduleWrite = (task: () => Promise<void>): Promise<void> => {
    writeQueue = writeQueue.then(async () => {
      if (failedError) {
        throw failedError;
      }
      await task();
    });

    return writeQueue.catch((error) => {
      failedError = error;
      throw error;
    });
  };

  const flushBatch = async (chunks: Uint8Array[], totalLen: number) => {
    ensureHealthy();
    if (totalLen <= 0) {
      return;
    }

    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    await activeTarget!.write(combined);
    committedBytes += totalLen;
  };

  const flushPending = async (): Promise<void> => {
    if (pendingBytes <= 0) {
      await writeQueue;
      if (failedError) {
        throw failedError;
      }
      return;
    }

    const { chunks, totalLen } = snapshotPending();
    await scheduleWrite(async () => {
      await flushBatch(chunks, totalLen);
    });
  };

  const clearTarget = (preserveCommittedBytes: boolean) => {
    activeTarget = null;
    clearPending();
    writeQueue = Promise.resolve();
    clearFailure();
    if (!preserveCommittedBytes) {
      committedBytes = 0;
    }
  };

  return {
    attachTarget: (target, attachOptions) => {
      activeTarget = target;
      clearPending();
      writeQueue = Promise.resolve();
      clearFailure();

      if (attachOptions?.resetCommittedBytes !== false) {
        committedBytes = attachOptions?.committedBytes ?? 0;
      } else if (typeof attachOptions?.committedBytes === 'number') {
        committedBytes = attachOptions.committedBytes;
      }
    },

    enqueueChunk: async (chunk) => {
      if (failedError) {
        throw failedError;
      }
      ensureHealthy();
      pendingChunks.push(chunk);
      pendingBytes += chunk.byteLength;

      if (pendingBytes >= options.flushThresholdBytes) {
        await flushPending();
      }
    },

    flushPending,

    awaitIdle: async () => {
      await writeQueue;
      if (failedError) {
        throw failedError;
      }
    },

    finalize: async () => {
      try {
        await flushPending();
        await writeQueue;
        ensureHealthy();
        await activeTarget!.close();
        clearTarget(false);
        return true;
      } catch {
        return false;
      }
    },

    closeCurrentTarget: async (closeOptions) => {
      if (!activeTarget) {
        clearPending();
        if (closeOptions?.preserveCommittedBytes === false) {
          committedBytes = 0;
        }
        clearFailure();
        return true;
      }

      const preserveCommittedBytes = closeOptions?.preserveCommittedBytes !== false;
      try {
        await writeQueue;

        if (
          closeOptions?.truncateNativeBeforeClose === true &&
          activeTarget.kind === 'native-fs' &&
          activeTarget.truncate
        ) {
          await activeTarget.truncate(0);
        }

        if (
          closeOptions?.abortStreamSaver === true &&
          activeTarget.kind === 'stream-saver' &&
          activeTarget.abort
        ) {
          await activeTarget.abort();
        } else {
          await activeTarget.close();
        }

        clearTarget(preserveCommittedBytes);
        return true;
      } catch {
        clearTarget(preserveCommittedBytes);
        return false;
      }
    },

    reopenForResume: async (factory, byteOffset) => {
      try {
        await writeQueue;
        const resumeOffset = typeof byteOffset === 'number' ? Math.max(0, byteOffset) : committedBytes;
        committedBytes = resumeOffset;
        const target = await factory(resumeOffset);
        activeTarget = target;
        clearPending();
        writeQueue = Promise.resolve();
        clearFailure();
        return true;
      } catch {
        activeTarget = null;
        return false;
      }
    },

    isStreaming: () => activeTarget !== null,
    hasRetainedData: () => pendingBytes > 0 || activeTarget !== null,
    getCommittedBytes: () => committedBytes,
    getBufferedBytes: () => pendingBytes,
    reset: () => {
      activeTarget = null;
      committedBytes = 0;
      clearPending();
      writeQueue = Promise.resolve();
      clearFailure();
    },
  };
};
